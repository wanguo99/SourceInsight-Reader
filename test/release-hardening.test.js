'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { SqliteIndexRepository } = require('../src/infrastructure/sqlite-index-repository');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
let parser;
test.before(async () => { parser = await createParser(); });
test.after(() => parser.delete());
const facts = (source, file, project) => ({ ...parseC(parser, source, 'file://' + file, file), project: 'file://' + project });
const calls = (index, name, direction = 'outgoing') => index.calls(index.item([...index.functions.values()].find(fn => fn.name === name)), direction);
async function persistent(t, files) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-hardening-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repository = new SqliteIndexRepository(directory, 'test'); t.after(() => repository.close());
  await repository.open(null, false, { descriptors: files }); files.forEach(file => repository.stage(file));
  const index = new CIndex(repository); index.replace([...repository.files.values()]); return { repository, index };
}

for (const persistentMode of [false, true]) test(`independent roots reject foreign SDK macros, types, calls and references (${persistentMode ? 'SQLite' : 'memory'})`, async t => {
  const header = facts('#define SDK_LIMIT 14\nstruct Frame { int value; };\nint api(void);', '/sdk/api.h', '/sdk');
  const implementation = facts('int api(void){return 1;}', '/sdk/api.c', '/sdk');
  const source = '#include "api.h"\nint run(struct Frame *f){return SDK_LIMIT + f->value + api();}';
  const current = facts(source, '/app/main.c', '/app');
  const files = [header, implementation, current];
  const index = persistentMode ? (await persistent(t, files)).index : new CIndex(); if (!persistentMode) index.replace(files);
  for (const name of ['SDK_LIMIT', 'value', 'api']) assert.deepEqual(index.definitions(current.uri, { line: 1, character: source.split('\n')[1].indexOf(name) }), []);
  assert.deepEqual(index.includeRelations(current.uri), []);
  assert(calls(index, 'run')[0].to.sourceInsightReaderLocal.unresolved);
  assert.deepEqual(calls(index, 'api', 'incoming'), []);
  assert(![...index.referenceSites(header.uri, { line: 0, character: 8 })].filter(Boolean).some(value => value.uri === current.uri));
});

test('relative and nested-root includes cannot bypass project isolation', () => {
  const files = [facts('#define FOREIGN 1', '/app/sdk/api.h', '/app/sdk'), facts('#include "sdk/api.h"\nint value=FOREIGN;', '/app/main.c', '/app')];
  const index = new CIndex(); index.replace(files);
  assert.deepEqual(index.definitions(files[1].uri, { line: 1, character: 10 }), []);
  assert.deepEqual(index.includeRelations(files[1].uri), []);
});

test('same-project SDK declarations and implementations remain usable after reopening the database', async t => {
  const files = [facts('#define LIMIT 14\nstruct Node { int value; };\nint api(void);', '/app/sdk/api.h', '/app'),
    facts('int api(void){return 1;}', '/app/sdk/api.c', '/app'),
    facts('#include "sdk/api.h"\nint run(struct Node *p){return LIMIT + p->value + api();}', '/app/main.c', '/app')];
  const { repository, index } = await persistent(t, files);
  await repository.open(null, false, { descriptors: files }); index.replace([...repository.files.values()]);
  assert.equal(calls(index, 'run')[0].to.uri, files[1].uri); assert.equal(calls(index, 'api', 'incoming')[0].from.uri, files[2].uri);
  for (const name of ['LIMIT', 'value']) {
    const source = 'int run(struct Node *p){return LIMIT + p->value + api();}';
    assert.equal(index.definitions(files[2].uri, { line: 1, character: source.indexOf(name) })[0].uri, files[0].uri);
  }
});

test('removing a workspace root closes its database connection and volatile graphs', async t => {
  const files = [facts('int a(void){return 1;}', '/app/a.c', '/app'), facts('int b(void){return 2;}', '/other/b.c', '/other')];
  const { repository, index } = await persistent(t, files);
  const dirty = facts('int b(void){return b();}', '/other/b.c', '/other'); repository.overlay(dirty); index.update(dirty);
  const durable = repository.forUri(files[1].uri), volatile = repository.graph.volatile.get(files[1].project);
  await repository.open(null, false, { descriptors: [files[0]] }); index.replace([...repository.files.values()]);
  assert.equal(repository.stores.size, 1); assert.equal(repository.graph.volatile.size, 0);
  assert.throws(() => durable.db.prepare('SELECT 1')); assert.throws(() => volatile.db.prepare('SELECT 1'));
});

test('headers included after a call cannot suppress it with a future function-pointer declaration', () => {
  const files = [facts('int (*leaf)(void);', '/app/api.h', '/app'), facts('int leaf(void){return 1;}', '/app/leaf.c', '/app'),
    facts('int run(void){return leaf();}\n#include "api.h"', '/app/main.c', '/app')];
  const index = new CIndex(); index.replace(files); assert.equal(calls(index, 'run')[0]?.to.uri, files[1].uri);
});

test('cast field lookup does not borrow a type from a future include', () => {
  const files = [facts('struct Node { int value; };', '/app/api.h', '/app'), facts('int run(void *p){return ((struct Node*)p)->value;}\n#include "api.h"', '/app/main.c', '/app')];
  const index = new CIndex(); index.replace(files);
  assert.deepEqual(index.definitions(files[1].uri, { line: 0, character: 43 }), []);
});

test('legacy cached graphs with foreign SDK edges are rebuilt under project isolation', async t => {
  const files = [facts('int api(void){return 1;}', '/sdk/api.h', '/sdk'), facts('#include "api.h"\nint run(void){return api();}', '/app/a.c', '/app')];
  const { repository } = await persistent(t, files), database = repository.forUri(files[1].uri);
  database.db.exec('DELETE FROM edges; DELETE FROM graphs;');
  const legacyKey = require('node:crypto').createHash('sha256').update('call-graph-2\n' + files[1].uri + ':' + files[1].hash).digest('hex');
  database.beginGraph(legacyKey); database.addEdge(legacyKey, { ...files[1].calls[0], file: files[1].uri, targets: [files[0].functions[0].id], resolved: true, candidateCount: 1 }); database.endGraph(legacyKey);
  await repository.open(null, false, { descriptors: files }); const index = new CIndex(repository); index.replace([...repository.files.values()]);
  assert(calls(index, 'run')[0].to.sourceInsightReaderLocal.unresolved);
  assert.deepEqual(calls(index, 'api', 'incoming'), []);
});

test('a missing file recovered by a query no longer remains in the worker issue list', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-query-recovery-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = { path: path.join(directory, 'a.c'), uri: pathToFileURL(path.join(directory, 'a.c')).toString(), project: pathToFileURL(directory).toString() };
  const worker = new Worker(path.join(__dirname, '../src/index-worker.js')); t.after(() => worker.terminate());
  const request = workerClient(worker, t);
  const initial = await request('scan', { files: [file], databaseDirectory: path.join(directory, 'cache') }); assert.equal(initial.failures.length, 1);
  await fs.writeFile(file.path, 'int recovered;');
  assert.equal((await request('symbols', { uri: file.uri }))[0].name, 'recovered');
  assert.deepEqual(await request('issues'), []);
  await request('shutdown');
});

test('structurally invalid compressed facts trigger recovery instead of silently empty symbols', async t => {
  const file = facts('int preserved;', '/app/a.c', '/app');
  const { repository } = await persistent(t, [file]); const database = repository.forUri(file.uri);
  const blob = require('node:zlib').deflateRawSync(Buffer.from('{}'));
  database.db.prepare('UPDATE files SET facts=? WHERE uri=?').run(blob, file.uri); database.evict(file.uri);
  assert.throws(() => database.fileFacts(file.uri), error => error.code === 'INDEX_CACHE_RECORD');
});

function workerClient(worker, t) {
  let sequence = 0; const pending = new Map();
  worker.on('message', message => { const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(message.error)) : item.resolve(message.result); });
  t.after(() => { for (const item of pending.values()) clearTimeout(item.timer); });
  return (action, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker timeout')); }, 15000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...args });
  });
}

function semanticFixture() {
  const env = fakeVscode(), doc = env.document('main.c', 'int run(void);');
  const foreign = env.api.Uri.parse('file:///foreign/api.h'), range = new env.api.Range(0, 0, 0, 3);
  const own = { uri: doc.uri, range }, other = { uri: foreign, range };
  const catalog = { accepts: () => true, projectKey: uri => uri.path.startsWith('/foreign/') ? 'foreign' : 'app' };
  return { env, doc, foreign, range, own, other, catalog };
}
test('semantic definitions, declarations, types and references never select another open project', async t => {
  const { env, doc, range, own, other, catalog } = semanticFixture();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const adapter = new LanguageAdapter(undefined, catalog); t.after(() => adapter.dispose());
  for (const command of ['vscode.executeDefinitionProvider', 'vscode.executeTypeDefinitionProvider', 'vscode.executeDeclarationProvider', 'vscode.executeReferenceProvider']) env.commands.set(command, async () => [own, other]);
  for (const result of [await adapter.definitions(doc.uri, range.start), await adapter.definitions(doc.uri, range.start, true), await adapter.declarations(doc.uri, range.start), await adapter.references(doc.uri, range.start)]) assert.deepEqual(result.map(value => value.uri.toString()), [doc.uri.toString()]);
});

test('semantic call preparation and both directions filter foreign project results and status', async t => {
  const { env, doc, foreign, range, catalog } = semanticFixture();
  const own = { uri: doc.uri, range, selectionRange: range, name: 'run', kind: 11 }, other = { ...own, uri: foreign, name: 'api' };
  const { LanguageServiceProvider } = loadWithVscode('../src/providers/relation-providers', env.api);
  const provider = new LanguageServiceProvider(catalog); t.after(() => provider.dispose());
  env.commands.set('vscode.prepareCallHierarchy', async () => [own, other]);
  const result = await provider.prepare({ uri: doc.uri.toString(), range }); assert.equal(result.data.length, 1);
  for (const direction of ['incoming', 'outgoing']) {
    env.commands.set(direction === 'incoming' ? 'vscode.provideIncomingCalls' : 'vscode.provideOutgoingCalls', async () => [{ [direction === 'incoming' ? 'from' : 'to']: other, fromRanges: [range] }]);
    const value = await provider.calls(result.data[0], direction); assert.deepEqual(value.data, []); assert.equal(value.status, 'empty');
  }
  provider.invalidate(); env.commands.set('vscode.prepareCallHierarchy', async () => [other]);
  assert.equal((await provider.prepare({ uri: doc.uri.toString(), range })).status, 'notFound');
});

test('semantic observations filter foreign targets before persistence and when reading old snapshots', async t => {
  const { env, doc, own, other, catalog } = semanticFixture();
  const { UnifiedIndexClient, serialize } = loadWithVscode('../src/infrastructure/unified-index-client', env.api);
  const client = new UnifiedIndexClient(env.context, catalog); t.after(() => client.dispose()); client.current = () => true;
  let captured; client.request = async (action, value) => { captured = value; return { data: serialize([own, other]) }; };
  const request = { snapshot: { uri: doc.uri.toString(), kind: 'definitions' } };
  await client.publish(request, [own, other]); assert.equal(captured.snapshot.data.length, 1);
  assert.equal((await client.read(request)).length, 1);
});

test('language-service system headers outside all opened projects are rejected', async t => {
  const { env, doc, range, catalog } = semanticFixture(); catalog.projectKey = uri => uri.path.startsWith('/project/') ? 'app' : undefined;
  const header = env.api.Uri.parse('file:///usr/include/stdio.h');
  env.commands.set('vscode.executeDefinitionProvider', async () => [{ uri: header, range }]);
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api), adapter = new LanguageAdapter(undefined, catalog); t.after(() => adapter.dispose());
  assert.deepEqual(await adapter.definitions(doc.uri, range.start), []);
});
