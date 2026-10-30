'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { IndexDatabase, SCHEMA } = require('../src/infrastructure/index-database');
const pack = value => zlib.deflateRawSync(Buffer.from(JSON.stringify(value)), {level:1});
const unpack = value => JSON.parse(zlib.inflateRawSync(value).toString());
const uri = 'file:///project/源码%20with%20spaces/very-long-component-name/header.h';
const symbol = (name, line) => ({name, uri, kind:12, range:{start:{line,character:0},end:{line,character:20}},
  selectionRange:{start:{line,character:4},end:{line,character:4+name.length}}, children:[], origin:'local'});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'reader-cache-compact-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return path.join(directory,'index.sqlite');
}
// Produce an actual version-5 layout and payload from the public version-6 API.
// Expected query results are captured before this conversion.
function legacy(file) {
  const db = new DatabaseSync(file);
  const rows = db.prepare('SELECT s.*,p.uri FROM symbols s JOIN symbol_files p ON p.id=s.file_id').all();
  const edges = db.prepare('SELECT e.rowid record_id,e.*,f.uri file,c.key caller,t.key target FROM edges e JOIN files f ON f.id=e.file_id JOIN function_keys c ON c.id=e.caller_id LEFT JOIN function_keys t ON t.id=e.target_id').all();
  db.exec(`BEGIN; DROP TABLE symbols; DROP TABLE symbol_files;
    CREATE TABLE symbols(provider TEXT NOT NULL,uri TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,folded TEXT NOT NULL,role TEXT NOT NULL,line INTEGER NOT NULL,col INTEGER NOT NULL,end_line INTEGER NOT NULL,end_col INTEGER NOT NULL,data BLOB NOT NULL,kind INTEGER NOT NULL,container TEXT NOT NULL,PRIMARY KEY(provider,uri,id,role));
    CREATE INDEX symbols_name ON symbols(provider,name,role); CREATE INDEX symbols_position ON symbols(uri,line,col); CREATE INDEX symbols_local ON symbols(uri,provider,role,name);`);
  const insert = db.prepare('INSERT INTO symbols VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const row of rows) insert.run(row.provider,row.uri,`${row.uri}:${row.line}:${row.col}:${row.name}`,row.name,row.folded,row.role,row.line,row.col,row.end_line,row.end_col,pack({...unpack(row.data),uri:row.uri}),row.kind,row.container);
  const update = db.prepare('UPDATE edges SET data=? WHERE rowid=?');
  for (const row of edges) {
    const value = unpack(row.data);
    update.run(pack(Array.isArray(value) ? {...value[1],caller:row.caller,file:row.file,name:row.name,targets:row.target===null?[]:[row.target],resolved:row.target!==null} : value),row.record_id);
  }
  db.exec("DELETE FROM meta WHERE key IN ('compactLayout','compactEdgesCursor'); PRAGMA user_version=5; COMMIT; VACUUM");
  db.close();
}

test('version-five symbols and graph migrate losslessly, reopen read-only and keep incremental updates', async t => {
  const file = await fixture(t); let store = new IndexDatabase(file,'project','parser');
  const nodes = [symbol('total',1),{...symbol('LIMIT',2),kind:13,category:'macro'},
    {...symbol('Record',3),kind:22,children:[{...symbol('field',4),kind:7}]}];
  store.activate([uri]);
  store.publish({uri,provider:'local',hash:'hash',facts:{uri,path:'/project/header.h',hash:'hash',symbols:nodes,locals:[{...symbol('local',5),scope:{start:{line:5,character:0},end:{line:9,character:0}}}],functions:[],calls:[],identifierNames:[],identifierData:new Int32Array(),includes:[],macros:['LIMIT']}});
  store.publish({uri,provider:'languageService',hash:'hash',kind:'symbols',data:[symbol('total',1)],buildKey:'config'});
  const graphEdges = [
    {caller:'caller',file:uri,name:'leaf',range:{start:{line:8,character:2},end:{line:8,character:6}},indirect:false,targets:['leaf'],candidateCount:1,resolved:true,extra:'preserved'},
    {caller:'caller',file:uri,name:'missing',range:{start:{line:9,character:2},end:{line:9,character:9}},indirect:false,targets:[],candidateCount:0,resolved:false}
  ];
  store.beginGraph('graph'); for (const edge of graphEdges) store.addEdge('graph',edge); store.endGraph('graph');
  const before = {outline:store.documentSymbols(uri),locals:store.findSymbols('local'),macros:store.macroSites('LIMIT'),search:store.search('total'),point:store.symbolAt(uri,{line:4,character:5})};
  store.close(); legacy(file);
  store = new IndexDatabase(file,'project','parser'); t.after(()=>store.close()); store.activate([uri]);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,SCHEMA);
  assert.equal(store.db.prepare('PRAGMA table_info(symbols)').all().some(row=>row.name==='uri'),false);
  assert.deepEqual({outline:store.documentSymbols(uri),locals:store.findSymbols('local'),macros:store.macroSites('LIMIT'),search:store.search('total'),point:store.symbolAt(uri,{line:4,character:5})},before);
  assert.deepEqual(store.edgeList('graph','caller',false),graphEdges);
  const reader = new IndexDatabase(file,'project','parser',undefined,true); reader.activate([uri]);
  assert.deepEqual(reader.edgeList('graph','leaf',true),[graphEdges[0]]); reader.close();
  assert(store.db.prepare('SELECT data FROM edges').all().every(row=>unpack(row.data)[0]===6));
  store.transaction(()=>store.writeSymbols(uri,'local',[symbol('replacement',6)]));
  assert.equal(store.findSymbols('total').length,0); assert.equal(store.findSymbols('replacement')[0].uri,uri);
  assert.equal(store.read({uri,provider:'languageService',hash:'hash',kind:'symbols',buildKey:'config'}).data[0].name,'total');
  store.delete(uri); assert.deepEqual(store.search('total'),[]); assert.equal(store.edgeCount('graph'),0);
});

test('interrupted symbol migration resumes without exposing a partial layout to readers', async t => {
  const file = await fixture(t); const initial = new IndexDatabase(file,'project','parser'); initial.activate([uri]);
  initial.transaction(()=>initial.writeSymbols(uri,'local',Array.from({length:2200},(_,n)=>symbol('item'+n,n)))); initial.close(); legacy(file);
  assert.throws(()=>new IndexDatabase(file,'project','parser',message=>{if(message.includes('符号'))throw new Error('injected interruption');}),/injected interruption/);
  assert.throws(()=>new IndexDatabase(file,'project','parser',undefined,true),/初始化或版本不兼容/);
  const resumed = new IndexDatabase(file,'project','parser'); t.after(()=>resumed.close()); resumed.activate([uri]);
  assert.equal(resumed.db.prepare('SELECT count(*) n FROM symbols').get().n,2200);
  assert.equal(resumed.findSymbols('item0').length,1); assert.equal(resumed.findSymbols('item2199').length,1);
});

test('rolling back a symbol write cannot leave an orphaned integer file ID', async t => {
  const file = await fixture(t), store = new IndexDatabase(file,'project','parser'); t.after(()=>store.close()); store.activate([uri]);
  assert.throws(()=>store.transaction(()=>{store.writeSymbols(uri,'local',[symbol('aborted',0)]);throw new Error('abort');}),/abort/);
  store.transaction(()=>store.writeSymbols(uri,'local',[symbol('retained',1)]));
  assert.equal(store.findSymbols('retained')[0].uri,uri); assert.equal(store.findSymbols('aborted').length,0);
});

test('an interrupted edge migration resumes its last committed batch', async t => {
  const file=await fixture(t), initial=new IndexDatabase(file,'project','parser');
  initial.activate([uri]);
  initial.publish({uri,provider:'local',hash:'hash',facts:{uri,path:'/project/header.h',hash:'hash',symbols:[],locals:[],functions:[],calls:[],includes:[],identifierNames:[],identifierData:new Int32Array()}});
  initial.beginGraph('graph');
  for(let n=0;n<2200;n++)initial.addEdge('graph',{caller:'caller',file:uri,name:'leaf',range:{start:{line:n,character:0},end:{line:n,character:4}},targets:['leaf'],candidateCount:1,resolved:true});
  initial.endGraph('graph'); initial.close(); legacy(file);
  assert.throws(()=>new IndexDatabase(file,'project','parser',message=>{if(message.includes('调用关系'))throw new Error('edge interruption');}),/edge interruption/);
  const resumed=new IndexDatabase(file,'project','parser'); t.after(()=>resumed.close()); resumed.activate([uri]);
  assert.equal(resumed.edgeList('graph','caller',false).length,2200);
  assert(resumed.db.prepare('SELECT data FROM edges').all().every(row=>unpack(row.data)[0]===6));
});

test('a corrupt legacy symbol does not block migration of healthy records', async t => {
  const file=await fixture(t), initial=new IndexDatabase(file,'project','parser'); initial.activate([uri]);
  const facts={uri,path:'/project/header.h',hash:'same',symbols:[symbol('healthy',1),symbol('broken',2)],locals:[],functions:[],calls:[],includes:[],identifierNames:[],identifierData:new Int32Array()};
  initial.publish({uri,provider:'local',hash:'same',facts}); initial.close(); legacy(file);
  const corrupt=new DatabaseSync(file); corrupt.prepare('UPDATE symbols SET data=? WHERE name=?').run(Buffer.from('invalid'),'broken'); corrupt.close();
  const messages=[], migrated=new IndexDatabase(file,'project','parser',message=>messages.push(message)); t.after(()=>migrated.close()); migrated.activate([uri]);
  assert.equal(migrated.findSymbols('healthy').length,1); assert.equal(migrated.findSymbols('broken').length,0);
  assert(messages.some(message=>message.includes('损坏记录'))); assert(migrated.states().some(state=>state.status==='cacheRecovery'));
  assert.equal(migrated.metadata().length,0); const revision=Number(migrated.meta('revision'));
  migrated.publish({uri,provider:'local',hash:'same',facts});
  assert.equal(migrated.metadata().length,1); assert(migrated.meta('revision')>revision);
  assert.equal(migrated.findSymbols('broken').length,1);
});

test('a corrupt legacy edge triggers graph rebuilding instead of blocking cache startup', async t => {
  const file=await fixture(t), initial=new IndexDatabase(file,'project','parser'); initial.activate([uri]);
  initial.publish({uri,provider:'local',hash:'hash',facts:{uri,path:'/project/header.h',hash:'hash',symbols:[],locals:[],functions:[],calls:[],includes:[],identifierNames:[],identifierData:new Int32Array()}});
  const edge={caller:'caller',file:uri,name:'leaf',range:{start:{line:1,character:0},end:{line:1,character:4}},targets:['leaf'],candidateCount:1,resolved:true};
  initial.beginGraph('graph'); initial.addEdge('graph',edge); initial.endGraph('graph'); initial.close(); legacy(file);
  const corrupt=new DatabaseSync(file); corrupt.prepare('UPDATE edges SET data=?').run(Buffer.from('invalid')); corrupt.close();
  const migrated=new IndexDatabase(file,'project','parser'); t.after(()=>migrated.close()); migrated.activate([uri]);
  assert.equal(migrated.graphReady('graph'),false); assert.deepEqual(migrated.edgeList('graph','caller',false),[]);
  migrated.beginGraph('graph'); migrated.addEdge('graph',edge); migrated.endGraph('graph');
  assert.deepEqual(migrated.edgeList('graph','caller',false),[edge]);
});

test('deferred space reclamation is retried on the next writable open', async t => {
  const file=await fixture(t);
  class DeferredDatabase extends IndexDatabase { compactFreePages() { return false; } }
  const deferred=new DeferredDatabase(file,'project','parser');
  assert.equal(deferred.meta('compactPending'),'1'); deferred.close();
  const reopened=new IndexDatabase(file,'project','parser'); t.after(()=>reopened.close());
  assert.equal(reopened.meta('compactPending'),'0'); assert.equal(reopened.meta('compactLayout'),'6');
});
