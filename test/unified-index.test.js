'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { IndexDatabase, databasePath } = require('../src/infrastructure/index-database');
const { SqliteIndexRepository } = require('../src/infrastructure/sqlite-index-repository');
const { createParser, parseC } = require('../src/c-parser');
const { parseCpp } = require('../src/cpp-outline');
const { CIndex } = require('../src/c-index');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
let parser;
test.before(async () => { parser = await createParser(); });
test.after(() => parser.delete());
async function fixture(t, sources) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-unified-'));
  const descriptors = Object.keys(sources).map(name => ({ uri: pathToFileURL(path.join(directory, name)).toString(), path: path.join(directory, name), project: pathToFileURL(directory).toString() }));
  const repository = new SqliteIndexRepository(path.join(directory, 'cache'), 'test');
  await repository.open(null, false, { descriptors });
  const facts = descriptors.map(file => ({ ...parseC(parser, sources[path.basename(file.path)], file.uri, file.path), project: file.project }));
  for (const file of facts) repository.stage(file);
  const index = new CIndex(repository); index.replace([...repository.files.values()]);
  t.after(async () => { repository.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, repository, descriptors, facts, index };
}
const outgoing = (index, name) => index.calls(index.item([...index.functions.values()].find(fn => fn.name === name)), 'outgoing');

test('aborted graph batches stay invisible and are removed without deleting the completed predecessor', async t => {
  const { repository, facts, index } = await fixture(t, { 'a.c': 'int leaf(void){return 1;} int run(void){return leaf();}' });
  const store = repository.forUri(facts[0].uri), key = repository.graph.keys.get(facts[0].project);
  const caller = [...index.functions.values()].find(fn => fn.name === 'run');
  const edge = store.edgeList(key, caller.id, false)[0];
  const reader = new IndexDatabase(store.path, facts[0].project, 'test', undefined, true);
  t.after(() => reader.close()); reader.activate([facts[0].uri]);
  store.beginGraph('interrupted');
  for (let i = 0; i < 2050; i++) store.addEdge('interrupted', edge);
  assert.equal(reader.edgeCount('interrupted'), 0);
  assert.equal(reader.edgeList('interrupted', caller.id, false).length, 0);
  assert.equal(reader.edgeCount(key), 1);
  store.endGraph('interrupted', false);
  assert.equal(store.statement('SELECT count(*) AS n FROM edges').get().n, 1);
  assert.equal(reader.edgeCount(key), 1);
  // Simulate an owner dying after the first committed batch.
  store.beginGraph('abandoned');
  for (let i = 0; i < 2048; i++) store.addEdge('abandoned', edge);
  store.db.exec('ROLLBACK');
  store.beginGraph('replacement', key, new Set()); store.endGraph('replacement');
  assert.equal(reader.edgeCount('replacement'), 1);
  assert.equal(store.statement('SELECT count(*) AS n FROM graphs').get().n, 1);
  assert.equal(store.statement('SELECT count(*) AS n FROM edges').get().n, 1);
});

test('partial file publication postpones graph construction until scanning completes', async t => {
  const { repository, facts, index } = await fixture(t, { 'a.c': 'int leaf(void){return 1;}', 'b.c': 'int run(void){return leaf();}' });
  const store = repository.forUri(facts[0].uri), begin = store.beginGraph.bind(store); let builds = 0;
  store.beginGraph = (...args) => { builds++; return begin(...args); };
  repository.graph.suspended = true;
  index.replace([repository.get(facts[1].uri)]);
  assert.equal(builds, 0);
  assert.equal(index.definitions(facts[1].uri, { line: 0, character: 4 }).length, 1);
  repository.graph.suspended = false;
  index.replace([repository.get(facts[1].uri)]);
  assert.equal(builds, 1);
});

test('component header targets reuse SQLite metadata and prefer quoted neighbors after reopening', async t => {
  const f = await fixture(t, { 'main.c': '#if CONFIG_ENABLED\n#include "service.h"\n#endif', 'service.h': '#pragma once\nint api(void);' });
  const include = { name: 'service.h', quoted: true }, source = f.facts[0];
  assert.equal(f.index.includeDefinitions(source.uri, include)[0].uri, f.facts[1].uri);
  await f.repository.open(undefined, false, { descriptors: f.descriptors }); f.index.replace([...f.repository.files.values()]);
  assert.equal(f.index.includeDefinitions(source.uri, include)[0].uri, f.facts[1].uri);
  const uri = source.uri.replace('/main.c', '/components/service.h'), file = source.path.replace('/main.c', '/components/service.h');
  const next = { ...parseC(parser, '', uri, file), project: source.project };
  f.repository.stage(next); f.index.update(f.repository.get(uri));
  assert.equal(f.index.includeDefinitions(source.uri, include).length, 1, 'A quoted adjacent header has priority');
  f.index.remove(f.facts[1].uri);
  assert.equal(f.index.includeDefinitions(source.uri, include)[0].uri, uri);
});

test('label namespaces and primitive typedef navigation survive SQLite reopen', async t => {
  const source = 'typedef unsigned long size_t;\nint run(size_t count) { int out = 1; goto out; out: return out; }\n' +
    'int other(void) { goto out; out: return 0; }';
  const f = await fixture(t, { 'labels.c': source }), file = f.facts[0];
  f.repository.close();
  const repository = new SqliteIndexRepository(f.repository.directory, 'test');
  t.after(() => repository.close());
  await repository.open(undefined, false, { descriptors: f.descriptors });
  const index = new CIndex(repository); index.replace([...repository.files.values()]);
  for (const line of [1, 2]) {
    const character = source.split('\n')[line].indexOf('goto out') + 5, token = repository.identifierAt(file.uri, { line, character });
    assert.equal(token.namespace, 'label');
    const target = index.definitions(file.uri, { line, character })[0];
    assert.equal(target.category, 'label'); assert.equal(target.selectionRange.start.line, line);
  }
  assert.equal(index.definitions(file.uri, { line: 1, character: 8 })[0].name, 'size_t');
  const variable = index.definitions(file.uri, { line: 1, character: source.split('\n')[1].lastIndexOf('out') })[0];
  assert.equal(variable.kind, 12);
});

test('warm symbol directories and function queries do not reload every file fact payload', async t => {
  const f = await fixture(t, { 'api.h': '#define VALUE 3\nint leaf(void);', 'a.c': '#include "api.h"\nint leaf(void){return VALUE;}' });
  const store = f.repository.forUri(f.facts[0].uri);
  t.mock.method(store, 'fileFacts', () => { throw new Error('Unexpected bulk facts load'); });
  const index = new CIndex(f.repository); index.replace([...f.repository.files.values()]);
  assert.equal(index.summary().files, 2); assert.equal(index.summary().functions, 1);
  assert.equal(index.workspaceSymbols('leaf').length, 2);
  const fn = index.prepare(f.facts[1].uri, { line: 1, character: 4 })[0];
  assert.equal(fn.name, 'leaf');
  assert.equal(index.definitions(f.facts[1].uri, { line: 1, character: 4 })[0].name, 'leaf');
  assert.equal(index.definitions(f.facts[1].uri, { line: 1, character: 'int leaf(void){return VALUE;}'.indexOf('VALUE') })[0].category, 'macro');
});

test('version four metadata migrates into a durable function directory without losing facts', async t => {
  const f = await fixture(t, { 'a.c': 'int leaf(void){return 1;}' }), facts = f.facts[0], file = f.repository.forUri(facts.uri).path;
  f.repository.close();
  const { DatabaseSync } = require('node:sqlite'), zlib = require('node:zlib');
  const old = new DatabaseSync(file);
  old.prepare('UPDATE files SET metadata=? WHERE uri=?').run(zlib.deflateRawSync(Buffer.from(JSON.stringify(facts))), facts.uri);
  old.exec('DROP TABLE functions; PRAGMA user_version=4'); old.close();
  const database = new IndexDatabase(file, facts.project, 'test'); t.after(() => database.close()); database.activate([facts.uri]);
  assert.equal(database.functionsNamed('leaf')[0].selectionRange.start.character, 4);
  assert.equal(database.fileMetadata(facts.uri).functionCount, 1);
  assert.equal(database.fileMetadata(facts.uri).functions, undefined);
  assert.equal(database.fileFacts(facts.uri).functions[0].name, 'leaf');
});

test('escaped paths preserve macro shadowing and canonical-URI navigation in SQLite', async t => {
  const f = await fixture(t, { '中文 main.c': 'int api(void){return 1;}\n#define api replacement\nint run(void){return api();}' });
  const file = f.facts[0], { uriKey } = require('../src/resources');
  assert.equal(f.index.resolve(file.uri, 'api', { line: 2, character: 21 }).length, 0);
  assert(f.index.definitions(uriKey(file.uri), { line: 2, character: 21 }).some(node => node.category === 'macro' && node.selectionRange.start.line === 1));
});

test('incremental graphs update callers whose URI contains escaped characters without duplicating edges', async t => {
  const f = await fixture(t, { 'leaf.c': 'int leaf(void){return 1;}', '调用 caller.c': 'int run(void){return leaf();}' });
  const original = f.facts[0], changed = { ...parseC(parser, 'int renamed(void){return 1;}', original.uri, original.path), project: original.project };
  f.repository.stage(changed); f.index.update(f.repository.get(changed.uri));
  const edges = outgoing(f.index, 'run'); assert.equal(edges.length, 1);
  assert.equal(edges[0].to.sourceInsightReaderLocal.unresolved, true); assert.equal(edges[0].to.name, 'leaf');
});

test('function and macro lookup caches observe changes committed by another database connection', async t => {
  const f = await fixture(t, { 'a.c': 'int old(void){return 1;}' }), facts = f.facts[0], store = f.repository.forUri(facts.uri);
  assert.equal(store.functionsNamed('added').length, 0); assert.equal(store.hasTopSymbol('NEW_VALUE', 13), false);
  const producer = new IndexDatabase(store.path, facts.project, 'test'); t.after(() => producer.close());
  const changed = { ...parseC(parser, '#define NEW_VALUE 2\nint added(void){return NEW_VALUE;}', facts.uri, facts.path), project: facts.project };
  producer.publish({ uri: facts.uri, hash: changed.hash, provider: 'local', kind: 'facts', facts: changed });
  assert.equal(store.functionsNamed('added')[0].selectionRange.start.line, 1); assert.equal(store.hasTopSymbol('NEW_VALUE', 13), true);
  assert.equal(store.functionsNamed('old').length, 0);
});

test('streamed directives preserve chunk boundary scopes, macro parameters and atomic rollback', async t => {
  const f = await fixture(t, { 'a.c': 'int seed;' }), file = f.facts[0], store = f.repository.forUri(file.uri);
  const source = ['#define BASE 1', '#if FEATURE', ...Array.from({ length: 900 }, (_, at) => `#define REG_${at} BASE`),
    '#undef BASE', '#endif', '#define FN(x) \\', '  ((x) + REG_899)', ''].join('\n');
  const metadata = store.writeDirectiveSource({ ...file, hash: 'streamed' }, source);
  f.repository.files.set(file.uri, f.repository.view(metadata, store));
  const index = new CIndex(f.repository); index.replace([...f.repository.files.values()]);
  assert.equal(metadata.symbolCount, 902); assert.equal(metadata.undefs[0].conditional, true);
  const position = { line: source.slice(0, source.lastIndexOf('REG_899')).split('\n').length - 1, character: source.split('\n').at(-2).indexOf('REG_899') };
  const target = index.definitions(file.uri, position); assert.equal(target[0].name, 'REG_899'); assert.equal(target[0].selectionRange.start.line, 901);
  const params = store.findSymbols('x', 'local', file.uri); assert.equal(params[0].category, 'macroParameter');
  assert(store.inPreprocessor(file.uri, position));
  let chunks = 0;
  assert.throws(() => store.writeDirectiveSource({ ...file, hash: 'failed' }, source, () => { if (++chunks > 4) throw new Error('injected interruption'); }), /interruption/);
  assert.equal(store.fileMetadata(file.uri).hash, 'streamed'); assert.equal(store.findSymbols('REG_899', 'top', file.uri).length, 1);
});

test('real worker streams a large macro file and navigates names beyond the bounded document list', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-stream-worker-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'registers.h'), source = Array.from({ length: 6000 }, (_, at) => `#define REGISTER_LONG_NAME_${at} ${at}`).join('\n');
  await fs.writeFile(file, source); const uri = pathToFileURL(file).toString(), project = pathToFileURL(directory).toString();
  const worker = new Worker(path.join(__dirname, '../src/index-worker.js')); t.after(() => worker.terminate());
  let sequence = 0; const pending = new Map();
  worker.on('message', message => { const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); });
  const request = (action, args = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => reject(new Error('stream worker timeout')), 15000); pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...args }); });
  const result = await request('scan', { files: [{ uri, path: file, project }], databaseDirectory: path.join(directory, 'cache') });
  assert.equal(result.files, 1); assert.equal(result.failures.length, 0);
  const listed = await request('symbols', { uri }); assert.equal(listed.length, 5000); assert.match(listed.sourceInsightReaderNote, /5000/);
  const targets = await request('definitions', { uri, position: { line: 5999, character: 8 } });
  assert.equal(targets[0].name, 'REGISTER_LONG_NAME_5999'); assert.equal(targets[0].selectionRange.start.line, 5999);
  const issues = await request('issues'); assert(issues.some(issue => issue.kind === 'limited' && issue.symbols === 6000));
  await request('shutdown');
});

test('persistent SQL queries agree with in-memory binding, references, fields and calls', async t => {
  const source = 'struct Node { int value; };\nint leaf(void) { return 1; }\nint run(struct Node *n) { int count=leaf(); return n->value + count; }';
  const { index, facts } = await fixture(t, { 'a.c': source });
  const memory = new CIndex(); memory.replace(facts);
  for (const point of [{ line: 2, character: source.split('\n')[2].indexOf('leaf') }, { line: 2, character: source.split('\n')[2].indexOf('value') }, { line: 2, character: source.split('\n')[2].lastIndexOf('count') }]) {
    assert.deepEqual(index.definitions(facts[0].uri, point), JSON.parse(JSON.stringify(memory.definitions(facts[0].uri, point))));
    assert.deepEqual([...index.referenceSites(facts[0].uri, point)], [...memory.referenceSites(facts[0].uri, point)]);
  }
  assert.deepEqual(outgoing(index, 'run'), outgoing(memory, 'run'));
  assert.deepEqual(index.workspaceSymbols('leaf'), memory.workspaceSymbols('leaf'));
});

test('reopening a project loads metadata first and reuses the durable graph', async t => {
  const { repository, descriptors, index } = await fixture(t, { 'a.c': 'int leaf(void){return 1;} int run(void){return leaf();}' });
  await repository.flush(); const before = index.summary();
  const other = new SqliteIndexRepository(repository.directory, 'test'); t.after(() => other.close());
  await other.open(null, false, { descriptors });
  assert.equal(other.diagnostics().cachedFactFiles, 0);
  const restored = new CIndex(other); restored.replace([...other.files.values()]);
  assert.equal(other.diagnostics().cachedFactFiles, 0, 'ready graph must not deserialize file facts at startup');
  assert.equal(restored.summary().calls, before.calls); assert.equal(outgoing(restored, 'run')[0].to.name, 'leaf');
});

test('dirty overlays resolve current variables and calls without changing durable facts or graph', async t => {
  const { repository, index, facts, descriptors } = await fixture(t, { 'a.c': 'int leaf(void){return 1;} int run(void){return leaf();}' });
  const cleanHash = facts[0].hash;
  const source = 'int next(void){return 2;} int run(void){int value=next(); return value;}';
  const dirty = { ...parseC(parser, source, facts[0].uri, facts[0].path), project: facts[0].project };
  repository.overlay(dirty); index.update(dirty);
  assert.equal(outgoing(index, 'run')[0].to.name, 'next');
  assert.equal(index.definitions(dirty.uri, { line: 0, character: source.lastIndexOf('value') })[0].name, 'value');
  assert.equal(repository.forUri(dirty.uri).fileMetadata(dirty.uri).hash, cleanHash);
  const other = new SqliteIndexRepository(repository.directory, 'test'); t.after(() => other.close());
  await other.open(null, false, { descriptors }); const restored = new CIndex(other); restored.replace([...other.files.values()]);
  assert.equal(outgoing(restored, 'run')[0].to.name, 'leaf');
  repository.stage(facts[0]); index.update(repository.get(facts[0].uri));
  assert.equal(outgoing(index, 'run')[0].to.name, 'leaf');
});

test('incremental graph replacement updates callers in other files and bounds graph generations', async t => {
  const { repository, index, facts } = await fixture(t, { 'a.c': 'int leaf(void){return 1;}', 'b.c': 'int run(void){return leaf();}' });
  for (let pass = 0; pass < 7; pass++) {
    const changed = { ...parseC(parser, `${'\n'.repeat(pass + 1)}int leaf(void){return 2;}`, facts[0].uri, facts[0].path), project: facts[0].project };
    repository.stage(changed); index.update(repository.get(changed.uri));
    assert.equal(outgoing(index, 'run')[0].to.selectionRange.start.line, pass + 1);
  }
  assert(repository.forUri(facts[0].uri).db.prepare('SELECT count(*) n FROM graphs').get().n <= 3);
});

test('project identity, provider separation, configuration keys and source hashes gate snapshot reads', () => {
  const database = new IndexDatabase(':memory:', 'project', 'test');
  try {
    const snapshot = { uri: 'file:///p/a.c', provider: 'languageService', kind: 'symbols', hash: 'one', buildKey: 'debug', quality: 'semantic', data: [{ name: 'ready', kind: 11, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }] };
    database.publish(snapshot); assert.equal(database.read(snapshot).data[0].name, 'ready');
    assert.equal(database.read({ ...snapshot, hash: 'two' }), undefined); assert.equal(database.read({ ...snapshot, buildKey: 'release' }), undefined);
    assert.equal(database.publish({ ...snapshot, dirty: true }).persisted, false);
    assert.equal(database.read({ ...snapshot, provider: 'local' }), undefined);
    assert.notEqual(databasePath('/cache', 'file:///a'), databasePath('/cache', 'file:///b'));
  } finally { database.close(); }
});

test('corrupt databases are backed up, while a newer schema is never overwritten', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-corrupt-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'index.sqlite'); await fs.writeFile(file, 'broken sqlite');
  const reports = [], database = new IndexDatabase(file, 'project', 'test', value => reports.push(value));
  assert.equal(reports.length, 1); assert((await fs.readdir(directory)).some(name => name.includes('.corrupt-')));
  database.db.exec('PRAGMA user_version=999'); database.close();
  assert.throws(() => new IndexDatabase(file, 'project', 'test'), /较新/);
  const { DatabaseSync } = require('node:sqlite'); const probe = new DatabaseSync(file); assert.equal(probe.prepare('PRAGMA user_version').get().user_version, 999); probe.close();
});

test('C++ namespace, class and method outlines survive without producing false C bindings', async () => {
  const cpp = await createParser('cpp');
  try {
    const facts = parseCpp(cpp, 'namespace N { class Box { public: int value; int get() { return value; } }; }', 'file:///p/a.cpp', '/p/a.cpp');
    assert.equal(facts.symbols[0].name, 'N'); assert.equal(facts.symbols[0].children[0].name, 'Box');
    assert.deepEqual(facts.symbols[0].children[0].children.map(node => node.name), ['value', 'get']);
    const index = new CIndex(); index.replace([facts]); assert.deepEqual(index.prepare(facts.uri, { line: 0, character: 49 }), []); assert.equal(facts.requiresSemantic, true);
  } finally { cpp.delete(); }
});

test('new files enter SQL queries immediately and excluded files stay on disk without leaking into queries', async t => {
  const { repository, index, descriptors, facts } = await fixture(t, { 'a.c': 'int original;' });
  const uri = facts[0].uri.replace('/a.c', '/new.c'), file = { ...parseC(parser, 'int added;', uri, facts[0].path.replace('/a.c', '/new.c')), project: facts[0].project };
  repository.stage(file); index.update(repository.get(uri)); assert.equal(index.workspaceSymbols('added')[0].name, 'added');
  await repository.open(null, false, { descriptors }); index.replace([...repository.files.values()]);
  assert.equal(index.workspaceSymbols('added').length, 0); assert(repository.forUri(facts[0].uri).fileMetadata(uri));
  repository.remove(facts[0].uri); index.remove(facts[0].uri); assert.equal(index.workspaceSymbols('original').length, 0);
});

test('same-named roots isolate symbols and removed roots cannot leak cached search results', async t => {
  const { repository, index, facts, descriptors } = await fixture(t, { 'a.c': 'int first;' });
  const other = { ...parseC(parser, 'int second;', 'file:///other/a.c', '/other/a.c'), project: 'file:///other' };
  repository.stage(other); index.replace([...repository.files.values()]); assert.equal(index.workspaceSymbols('second').length, 1);
  assert.equal(repository.findSymbols('second', facts[0].project).length, 0);
  await repository.open(null, false, { descriptors }); index.replace([...repository.files.values()]); assert.equal(index.workspaceSymbols('second').length, 0);
});

test('a failed provider snapshot rolls back its replacement atomically', () => {
  const database = new IndexDatabase(':memory:', 'p', 'test');
  const snapshot = { uri: 'file:///p/a.c', provider: 'languageService', hash: 'one', kind: 'symbols', data: [{ name: 'kept', kind: 11, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } }] };
  try {
    database.publish(snapshot);
    assert.throws(() => database.publish({ ...snapshot, data: [snapshot.data[0], { ...snapshot.data[0], name: 'bad', kind: undefined }] }));
    assert.equal(database.read(snapshot).data[0].name, 'kept'); database.activate([snapshot.uri]); assert.equal(database.search('kept')[0].name, 'kept');
  } finally { database.close(); }
});

test('an unavailable cache directory falls back to a diagnosed temporary index', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-fallback-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const blocked = path.join(directory, 'file'); await fs.writeFile(blocked, 'occupied'); const reports = [];
  const repository = new SqliteIndexRepository(blocked, 'test', message => reports.push(message)); t.after(() => repository.close());
  await repository.open(null, false, { descriptors: [{ uri: 'file:///p/a.c', project: 'p' }] });
  assert.equal(repository.diagnostics().volatileProjects, 1); assert.match(reports[0], /临时内存索引/);
});

test('lazy fact caching stays bounded and one corrupt metadata record does not discard healthy files', async t => {
  const { repository, descriptors, facts } = await fixture(t, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${i}.c`, `int value${i};`])));
  for (const file of facts) repository.get(file.uri).symbols;
  assert(repository.diagnostics().cachedFactFiles <= 4);
  const database = repository.forUri(facts[0].uri); database.db.prepare('UPDATE files SET metadata=? WHERE uri=?').run(Buffer.from('bad'), facts[0].uri);
  await repository.open(null, false, { descriptors }); assert.equal(repository.files.size, 7); assert(repository.get(facts[1].uri));
});

test('hot search results invalidate when another connection publishes or deletes symbols', async t => {
  const { repository, facts, index } = await fixture(t, { 'a.c': 'int local;' });
  assert.equal(index.workspaceSymbols('semantic').length, 0);
  const database = new IndexDatabase(repository.forUri(facts[0].uri).path, facts[0].project, 'test'); t.after(() => database.close());
  const snapshot = { uri: facts[0].uri, provider: 'languageService', kind: 'symbols', hash: facts[0].hash, data: [{ name: 'semantic', kind: 11, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } } }] };
  database.publish(snapshot); assert.equal(index.workspaceSymbols('semantic').length, 1);
  database.publish({ ...snapshot, data: [] }); assert.equal(index.workspaceSymbols('semantic').length, 0);
});

test('VS Code URI and accessor-based ranges survive provider snapshot serialization', () => {
  const env = fakeVscode(), { serialize, deserialize } = loadWithVscode('../src/infrastructure/unified-index-client', env.api);
  const value = { uri: env.api.Uri.file('/中文/a.c'), range: { get start() { return { line: 1, character: 2 }; }, get end() { return { line: 1, character: 8 }; } } };
  const restored = deserialize(serialize(value)); assert.equal(restored.uri.toString(), value.uri.toString()); assert.equal(restored.range.start.character, 2);
});

test('file IDs remain stable after deletion and compaction', async t => {
  const { repository, facts } = await fixture(t, { 'a.c': 'int first;', 'b.c': 'int second;' });
  repository.remove(facts[0].uri);
  const database = repository.forUri(facts[1].uri); database.db.exec('VACUUM');
  assert.equal([...database.occurrences('second')][0].uri, facts[1].uri);
  assert.equal(database.identifierAt(facts[1].uri, { line: 0, character: 5 }).name, 'second');
});

test('legacy URI occurrence tables migrate without losing positions', async t => {
  const { repository, facts } = await fixture(t, { 'a.c': 'int first;', 'b.c': 'int second;' });
  const file = repository.forUri(facts[0].uri).path;
  repository.close();
  const { DatabaseSync } = require('node:sqlite'); const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE old_occurrences(uri TEXT NOT NULL,name TEXT NOT NULL,line INTEGER NOT NULL,col INTEGER NOT NULL,end_line INTEGER NOT NULL,end_col INTEGER NOT NULL,namespace INTEGER NOT NULL,tag INTEGER NOT NULL,receiver_line INTEGER NOT NULL,receiver_col INTEGER NOT NULL);
    INSERT INTO old_occurrences SELECT f.uri,o.name,o.line,o.col,o.end_line,o.end_col,o.namespace,o.tag,o.receiver_line,o.receiver_col FROM occurrences o JOIN files f ON f.id=o.file_id;
    DROP TABLE occurrences; ALTER TABLE old_occurrences RENAME TO occurrences;
    CREATE INDEX occurrences_name ON occurrences(name,uri); CREATE INDEX occurrences_position ON occurrences(uri,line,col); PRAGMA user_version=2;`);
  old.close(); const database = new IndexDatabase(file, facts[0].project, 'test'); t.after(() => database.close()); database.activate(facts.map(f => f.uri));
  assert.equal([...database.occurrences('second')][0].uri, facts[1].uri);
  assert.equal(database.identifierAt(facts[1].uri, { line: 0, character: 5 }).name, 'second');
});

test('legacy string graph keys migrate to integer dictionaries without changing calls', async t => {
  const { repository, facts, index } = await fixture(t, { 'a.c': 'int leaf(void){return 1;} int run(void){return leaf();}' });
  const expected = outgoing(index, 'run'), file = repository.forUri(facts[0].uri).path, graphKey = repository.graph.keys.get(facts[0].project);
  const caller = [...index.functions.values()].find(fn => fn.name === 'run');
  repository.close();
  const { DatabaseSync } = require('node:sqlite'); const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE old_edges(graph_key TEXT NOT NULL,provider TEXT NOT NULL,file TEXT NOT NULL,caller TEXT NOT NULL,target TEXT,name TEXT NOT NULL,line INTEGER NOT NULL,col INTEGER NOT NULL,data BLOB NOT NULL);
    INSERT INTO old_edges SELECT g.graph_key,e.provider,f.uri,c.key,t.key,e.name,e.line,e.col,e.data FROM edges e JOIN graphs g ON g.id=e.graph_id JOIN files f ON f.id=e.file_id JOIN function_keys c ON c.id=e.caller_id LEFT JOIN function_keys t ON t.id=e.target_id;
    DROP TABLE edges; ALTER TABLE old_edges RENAME TO edges;
    CREATE INDEX edges_outgoing ON edges(graph_key,provider,caller); CREATE INDEX edges_incoming ON edges(graph_key,provider,target); CREATE INDEX edges_file ON edges(graph_key,provider,file);
    CREATE TABLE old_graphs(graph_key TEXT PRIMARY KEY,ready INTEGER NOT NULL,updated INTEGER NOT NULL);
    INSERT INTO old_graphs SELECT graph_key,ready,updated FROM graphs; DROP TABLE graphs; ALTER TABLE old_graphs RENAME TO graphs; PRAGMA user_version=3;`);
  old.close(); const database = new IndexDatabase(file, facts[0].project, 'test'); t.after(() => database.close()); database.activate(facts.map(f => f.uri));
  assert.equal(database.graphReady(graphKey), true); assert.equal(database.edgeCount(graphKey), 1);
  assert.equal(database.edgeList(graphKey, caller.id, false)[0].targets[0], expected[0].to.sourceInsightReaderLocal.id);
});

test('real SQL worker reparses changed targets, recovers corrupt facts, and discards dirty overlays on reopen', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-worker-sql-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const a = path.join(directory, 'a.c'), b = path.join(directory, 'b.c'), project = pathToFileURL(directory).toString();
  await fs.writeFile(a, 'int leaf(void){return 1;}'); await fs.writeFile(b, 'int run(void){return leaf();}');
  const files = [a, b].map(file => ({ uri: pathToFileURL(file).toString(), path: file, project }));
  const cache = path.join(directory, 'cache');
  const worker = new Worker(path.join(__dirname, '../src/index-worker.js')); t.after(() => worker.terminate());
  let sequence = 0; const pending = new Map(), diagnostics = [];
  worker.on('message', message => { if (message.diagnostic) diagnostics.push(message.diagnostic); const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); });
  const request = (action, args = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => reject(new Error('SQL worker timeout')), 10000); pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...args }); });
  await request('scan', { files, databaseDirectory: cache });
  await fs.writeFile(a, '\n\nint leaf(void){return 2;}');
  const locations = await request('definitions', { uri: files[1].uri, position: { line: 0, character: 21 } }); assert.equal(locations[0].selectionRange.start.line, 2);
  await request('update', { file: { ...files[1], text: 'int dirty(void){return 3;}' }, dirty: true });
  assert.equal((await request('symbols', { uri: files[1].uri }))[0].name, 'dirty');
  const failed = await request('update', { file: { ...files[1], text: ' '.repeat(17 * 1048576) }, dirty: true });
  assert.equal(failed.failures.length, 1); assert.deepEqual(await request('symbols', { uri: files[1].uri }), []);
  assert.equal((await request('workspaceSymbols', { query: 'run' })).length, 0, 'failed dirty text must not reveal saved coordinates');
  const restored = await request('scan', { files, databaseDirectory: cache }); assert.equal(restored.parsedFiles, 0); assert.equal((await request('symbols', { uri: files[1].uri }))[0].name, 'run');
  const { PARSER_ID } = require('../src/infrastructure/index-schema'); const database = new IndexDatabase(databasePath(cache, project), project, PARSER_ID);
  database.db.prepare('UPDATE files SET facts=? WHERE uri=?').run(Buffer.from('bad'), files[1].uri); database.close();
  // Reopen to remove the bounded hot-facts cache before testing disk corruption.
  await request('scan', { files, databaseDirectory: cache });
  assert.equal((await request('symbols', { uri: files[1].uri }))[0].name, 'run');
  assert(diagnostics.some(message => message.includes('缓存损坏已重新解析')));
  await request('shutdown');
});

test('language-service capability failures are cached per command and reset on configuration changes', async () => {
  const env = fakeVscode(); let attempts = 0, configuration = 'one';
  env.api.commands.executeCommand = async () => { attempts++; throw Object.assign(new Error('method not found'), { code: -32601 }); };
  const { LanguageServiceProvider } = loadWithVscode('../src/providers/relation-providers', env.api);
  const provider = new LanguageServiceProvider({ configurationKey: () => configuration });
  try {
    const uri = env.api.Uri.file('/p/a.c');
    assert.equal(await provider.execute('one', 'vscode.provideOutgoingCalls', { uri }), undefined);
    assert.equal(await provider.execute('two', 'vscode.provideOutgoingCalls', { uri }), undefined); assert.equal(attempts, 1);
    configuration = 'two'; await provider.execute('three', 'vscode.provideOutgoingCalls', { uri }); assert.equal(attempts, 2);
  } finally { provider.dispose(); }
});

test('a valid semantic outline cache precedes syntax fallback and respects explicit local mode', async () => {
  const env = fakeVscode(), document = env.document('cache.cpp', ' ');
  const range = new env.api.Range(0, 0, 0, 1), node = name => ({ name, kind: 11, range, selectionRange: range, children: [] });
  env.api.workspace.openTextDocument = async () => document; env.api.commands.executeCommand = async () => [];
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const local = { enabled: () => true, supports: () => true, symbols: async () => [node('syntax')], log: () => {} };
  const store = { observe: (kind, uri, query, action) => action(), descriptor: () => ({}), read: async () => [node('compiler')] };
  const adapter = new LanguageAdapter(local, { accepts: () => true, document: () => document }, store);
  try {
    assert.equal((await adapter.symbols(document.uri))[0].name, 'compiler'); assert.equal(adapter.queryInfo('symbols', document.uri).status, 'cached');
    env.settings.set('sourceInsightReader.navigationBackend', 'local');
    assert.equal((await adapter.symbols(document.uri))[0].name, 'syntax');
  } finally { adapter.dispose(); }
});

test('database worker writes language symbols into the same per-folder database as the local producer', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-semantic-db-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const worker = new Worker(path.join(__dirname, '../src/database-worker.js')); t.after(() => worker.terminate());
  let sequence = 0;
  const request = data => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
    worker.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.result); }); worker.postMessage({ id, ...data });
  });
  const message = { directory, project: 'file:///p', root: directory, configuration: 'debug', snapshot: { uri: 'file:///p/a.c', hash: 'one', kind: 'symbols', data: [{ name: 'semantic', kind: 11, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } }] } };
  assert.equal((await request({ ...message, action: 'publish' })).persisted, true);
  assert.equal((await request({ ...message, action: 'read' })).data[0].name, 'semantic');
  assert.equal(await request({ ...message, configuration: 'release', action: 'read' }), undefined);
  const { PARSER_ID } = require('../src/infrastructure/index-schema');
  const database = new IndexDatabase(databasePath(directory, message.project), message.project, PARSER_ID); database.activate([message.snapshot.uri]);
  assert.equal(database.search('semantic')[0].name, 'semantic'); database.close(); await request({ action: 'close' });
});

test('local scanning and semantic publishing can commit concurrently to the same project', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-two-writers-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = pathToFileURL(directory).toString(), cache = path.join(directory, 'cache');
  const files = [];
  for (let i = 0; i < 80; i++) { const file = path.join(directory, `${i}.c`); await fs.writeFile(file, `int value${i}(void){return value0();}`); files.push({ path: file, uri: pathToFileURL(file).toString(), project }); }
  const local = new Worker(path.join(__dirname, '../src/index-worker.js')), semantic = new Worker(path.join(__dirname, '../src/database-worker.js'));
  t.after(async () => { await local.terminate(); await semantic.terminate(); });
  const client = worker => { let sequence = 0; const pending = new Map(); worker.on('message', message => { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error(message.error)) : p.resolve(message.result); }); return data => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => reject(new Error('concurrent write timeout')), 10000); pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, ...data }); }); };
  const request = client(local), publish = client(semantic);
  const first = new Promise(resolve => { const listener = message => { if (message.snapshot) { local.off('message', listener); resolve(); } }; local.on('message', listener); });
  const scanning = request({ action: 'scan', files, databaseDirectory: cache }); await first;
  const hash = require('node:crypto').createHash('sha256').update(await fs.readFile(files[0].path)).digest('hex');
  const snapshot = { uri: files[0].uri, hash, kind: 'symbols', data: [{ name: 'compiler_symbol', kind: 11, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } }] };
  const [summary, saved] = await Promise.all([scanning, publish({ action: 'publish', directory: cache, project, root: directory, configuration: '', snapshot })]);
  assert.equal(summary.files, files.length); assert.equal(saved.persisted, true);
  assert.equal((await request({ action: 'workspaceSymbols', query: 'compiler_symbol' }))[0].name, 'compiler_symbol');
  await request({ action: 'shutdown' }); await publish({ action: 'close' });
});
