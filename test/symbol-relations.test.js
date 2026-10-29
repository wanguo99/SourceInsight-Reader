'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { SqliteIndexRepository } = require('../src/infrastructure/sqlite-index-repository');
const sources = {
  'config.h': '#define LIMIT 3\n#define CHECK(x) ((x) < LIMIT)\n#define DERIVED (LIMIT + 1)\nstruct State { int value; };\nenum Mode { MODE_IDLE, MODE_RUN };\ntypedef enum Mode Mode;\nextern struct State global_state;\n',
  'use.c': '#include "config.h"\nstruct State global_state = { .value = LIMIT };\nint read_state(enum Mode mode) { global_state.value++; return CHECK(global_state.value) + MODE_IDLE + LIMIT; }\nint local_state(void) { struct State global_state; global_state.value = MODE_RUN; return global_state.value; }\nMode get_mode(void) { return MODE_IDLE; }\n#if LIMIT\nint conditional;\n#endif\n',
  'other.c': '#include "config.h"\nstatic struct State global_state;\nint other(void) { return global_state.value + MODE_RUN; }\n#undef LIMIT\nint after_undef(void) { return LIMIT; }\n'
};
async function fixture(t, persistent) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-symbol-relations-'));
  const project = pathToFileURL(directory).toString(), parser = await createParser();
  const files = Object.entries(sources).map(([name, source]) => {
    const file = path.join(directory, name); return { ...parseC(parser, source, pathToFileURL(file).toString(), file), project };
  }); parser.delete();
  const repository = persistent ? new SqliteIndexRepository(path.join(directory, 'cache'), 'symbol-relations') : undefined;
  if (repository) {
    const descriptors = files.map(({uri, path, project}) => ({uri, path, project}));
    await repository.open(undefined, false, { descriptors });
    for (const file of files) repository.stage(file);
    await repository.open(undefined, false, { descriptors });
  }
  const index = new CIndex(repository); index.replace(repository ? [...repository.files.values()] : files);
  t.after(async () => { repository?.close(); await fs.rm(directory, {recursive:true,force:true}); });
  const at = (file, text, offset = 0) => {
    const position = sources[file].indexOf(text); assert(position >= 0, text);
    const prefix = sources[file].slice(0, position + offset).split('\n');
    return { uri: files.find(value => value.path.endsWith(file)).uri, point: {line:prefix.length - 1, character:prefix.at(-1).length} };
  };
  const root = (file, text, offset = 0) => { const source = at(file, text, offset), values = index.prepare(source.uri, source.point); assert.equal(values.length, 1, text); return index.item(values[0]); };
  return {index,files,repository,at,root};
}
for (const persistent of [false, true]) {
  test(`macro, structure variables, enum types and constants expose bound uses (${persistent ? 'reopened SQLite' : 'memory'})`, async t => {
    const f = await fixture(t, persistent);
    const macro = f.root('config.h', 'LIMIT'); assert.equal(macro.kind,13);
    const uses = f.index.calls(macro,'incoming');
    assert(uses.some(call => call.from.name === 'CHECK'));
    assert(uses.some(call => call.from.name === 'DERIVED'));
    assert(uses.some(call => call.from.name === 'global_state'));
    assert(uses.some(call => call.from.name === 'read_state'));
    assert(!uses.some(call => call.from.name === 'after_undef'));
    assert(uses.some(call => call.from.kind === 0), 'Preprocessor conditions outside functions retain their exact sites');
    assert(uses.every(call => call.siteLocations.every(site => !(site.uri.endsWith('/config.h') && site.range.start.line === 0))));
    assert.deepEqual(f.index.calls(macro,'outgoing'),[]);
    assert.equal(f.root('use.c','CHECK(global_state').kind,13, 'Function-like macros remain symbol roots');
    const variable = f.root('use.c','global_state ='); assert.equal(variable.kind,12);
    const variableUses = f.index.calls(variable,'incoming');
    assert(variableUses.some(call => call.from.name === 'read_state'));
    assert(!variableUses.some(call => ['local_state','other'].includes(call.from.name)), 'Shadowed variables do not mix');
    const local = f.root('use.c','global_state;',0);
    assert.deepEqual(f.index.calls(local,'incoming').map(call=>call.from.name),['local_state']);
    const mode = f.root('config.h','Mode {'); assert.equal(mode.kind,9);
    assert(f.index.calls(mode,'incoming').some(call=>call.from.name==='read_state'));
    const enumerator = f.root('config.h','MODE_IDLE'); assert.equal(enumerator.kind,21);
    assert.deepEqual(f.index.calls(enumerator,'incoming').map(call=>call.from.name).sort(),['get_mode','read_state']);
    const type = f.root('config.h','State {'); assert.equal(type.kind,22);
    assert(f.index.calls(type,'incoming').some(call=>call.from.name==='local_state'));
    assert.match(f.index.callDiagnostics(enumerator,'outgoing').join(' '),/使用位置/);
  });
}
test('symbol-use caches follow index updates and keep independent projects separate', async t => {
  const f = await fixture(t,false), parser=await createParser();
  const old=f.files.find(file=>file.uri.endsWith('/use.c'));
  const original=f.root('config.h','MODE_IDLE'); assert(f.index.calls(original,'incoming').length>0);
  f.index.update({...parseC(parser,'#include "config.h"\n',old.uri,old.path),project:old.project});
  const foreign=f.files.map(file=>({...file,uri:file.uri.replace('/config.h','/foreign/config.h').replace('/use.c','/foreign/use.c').replace('/other.c','/foreign/other.c'),path:path.join(path.dirname(file.path),'foreign',path.basename(file.path)),project:'foreign'}));
  // Parse again so every nested node has the independent project's URI.
  const independent=foreign.map(file=>({...parseC(parser,sources[path.basename(file.path)],file.uri,file.path),project:'foreign'}));
  parser.delete();f.index.replace([...f.index.files.values(),...independent]);
  assert.deepEqual(f.index.calls(f.root('config.h','MODE_IDLE'),'incoming'),[]);
});
test('automatic C following preserves non-call identifiers for symbol-use relations',()=>{
  const {fakeVscode,loadWithVscode}=require('./fake-vscode');
  const env=fakeVscode(),document=env.document('follow.c','int read(void) { return LIMIT + global_state.value + MODE_IDLE; }');
  const {FollowController}=loadWithVscode('../src/application/follow-controller',env.api);
  const follow=new FollowController({session:{editor:{document}}});
  const fn={name:'read',uri:document.uri,kind:11,range:new env.api.Range(0,0,0,80),selectionRange:new env.api.Range(0,4,0,8)};
  try{for(const name of ['LIMIT','global_state','MODE_IDLE']){
    const position=document.text.indexOf(name),source={uri:document.uri,name,range:new env.api.Range(0,position,0,position)};
    assert.equal(follow.relationSource(fn,source).name,name);
  }}finally{follow.dispose();}
});
