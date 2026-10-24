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
const { decodeSource } = require('../src/infrastructure/source-text');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

async function project(t, sources) {
  const parser = await createParser(); t.after(() => parser.delete());
  const index = new CIndex();
  index.replace(Object.entries(sources).map(([name, source]) => ({
    ...parseC(parser, source, 'file:///project/' + name, '/project/' + name), project: 'project'
  })));
  return { index, at(file, line, name) {
    const character = sources[file].split('\n')[line].lastIndexOf(name);
    assert(character >= 0);
    return { uri: 'file:///project/' + file, point: { line, character } };
  } };
}

test('file-scope callback objects shadow external functions, including aliases and included declarations', async t => {
  const sources = {
    'external.c': 'int callback(void) { return 1; }\n',
    'callbacks.h': 'typedef int (*Callback)(void);\nextern Callback header_callback;\n',
    'consumer.c': '#include "callbacks.h"\nstatic int other(void) { return 2; }\n' +
      'static Callback callback = other;\nint run(void) { return callback() + header_callback(); }\n',
    'header.c': 'int header_callback(void) { return 9; }\n'
  };
  const { index, at } = await project(t, sources);
  const query = at('consumer.c', 3, 'callback() +');
  const definition = index.definitions(query.uri, query.point);
  assert.equal(definition.length, 1); assert.equal(definition[0].selectionRange.start.line, 2);
  assert.equal(definition[0].uri, query.uri);
  const run = index.prepare(query.uri, { line: 3, character: 4 }, 'run')[0];
  assert.deepEqual(index.calls(index.item(run), 'outgoing'), []);
  assert.match(index.callDiagnostics(index.item(run), 'outgoing').join(' '), /2 处间接调用/);
  const external = index.prepare('file:///project/external.c', { line: 0, character: 4 })[0];
  assert.deepEqual(index.calls(index.item(external), 'incoming'), []);
  assert.deepEqual(index.prepare(query.uri, query.point), []);
});

test('prototype parameters resolve to their own declarations and never escape the declarator', async t => {
  const { index, at } = await project(t, { 'a.c': 'int arg;\nint api(int arg, int (*cb)(int arg));\nint run(void) { return arg; }\n' });
  for (const character of [12, 31]) {
    const values = index.definitions('file:///project/a.c', { line: 1, character });
    assert.equal(values.length, 1); assert.equal(values[0].selectionRange.start.line, 1);
  }
  const query = at('a.c', 2, 'arg');
  assert.equal(index.definitions(query.uri, query.point)[0].selectionRange.start.line, 0);
  assert.equal(index.workspaceSymbols('arg').filter(value => value.name === 'arg').length, 1);
});

test('unseen enum values and typedef members do not become confirmed definitions', async t => {
  const { index, at } = await project(t, {
    'hidden.h': 'enum Mode { HIDDEN };\ntypedef struct { int value; } Hidden;\n',
    'a.c': 'int run(void) { return HIDDEN; }\nvoid read(Hidden *p) { p->value; }\n',
    'b.c': '#include "hidden.h"\nint visible(void) { return HIDDEN; }\n'
  });
  for (const [line, name] of [[0, 'HIDDEN'], [1, 'value']]) {
    const query = at('a.c', line, name); assert.deepEqual(index.definitions(query.uri, query.point), []);
  }
  const query = at('b.c', 1, 'HIDDEN'); assert.equal(index.definitions(query.uri, query.point).length, 1);
});

test('C++ headers are rejected conservatively without rejecting comments or ordinary C declarations', async t => {
  const parser = await createParser(); t.after(() => parser.delete());
  for (const text of ['namespace n { inline int leaf() { return 1; } }', 'template<class T> class Box {};',
    'class Derived : public Base {};', 'class Forward;', 'using namespace std;', 'using Alias = int;', 'int X::read() { return 1; }']) {
    assert.throws(() => parseC(parser, text, 'file:///project/api.h', '/project/api.h'), /C\+\+ 头文件/);
  }
  const facts = parseC(parser, '// namespace n {\n/* class Bad {}; */\nstruct Good { int value; };\n',
    'file:///project/api.h', '/project/api.h');
  assert.equal(facts.hasErrors, false); assert.deepEqual(facts.functions, []);
});

test('source decoding honors UTF BOMs and configured legacy encodings and rejects corrupt/binary bytes', () => {
  const source = '// 中文\nint leaf(void) { return 1; }\n';
  const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')]);
  const big = Buffer.from(little); big.swap16();
  assert.equal(decodeSource(little), source); assert.equal(decodeSource(big), source);
  assert.equal(decodeSource(Buffer.from(source)), source);
  assert.equal(decodeSource(Buffer.from([0xe9]), 'windows1252'), 'é');
  assert.throws(() => decodeSource(Buffer.from([0xff])), /解码/);
  assert.throws(() => decodeSource(Buffer.from([0, 0, 1])), /NUL/);
});

test('C-compatible headers keep offline reading despite the editor default C++ label', t => {
  const env = fakeVscode(), document = env.document('api.h', 'struct Record { int value; };');
  env.api.workspace.textDocuments = [document];
  const cache = new Map(), load = file => loadWithVscode(require.resolve(file), env.api, cache);
  const catalog = new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
  const local = new (load('../src/local-index').LocalIndex)(env.context, catalog);
  t.after(() => { local.dispose(); catalog.dispose(); });
  assert.equal(document.languageId, 'cpp'); assert.equal(local.supports(document.uri), true);
  document.text = 'namespace n { class Record {}; }'; document.version++;
  assert.equal(local.supports(document.uri), false);
  document.text = 'struct Record {};'; document.version++;
  env.settings.set('files.associations', { '*.h': 'cpp' }); assert.equal(local.supports(document.uri), false);
});

test('workspace roots remain separate after exclusions while SDK locations remain accessible', () => {
  const env = fakeVscode(), load = file => loadWithVscode(require.resolve(file), env.api);
  env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file('/one'), name: 'one' }, { uri: env.api.Uri.file('/two'), name: 'two' }];
  const catalog = new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
  try {
    env.settings.set('sourceInsightReader.excludedDirectories', ['one/build']);
    assert.equal(catalog.scopeKey().length, 64, 'scope identity must not repeat large exclusion lists per file');
    assert.notEqual(catalog.projectKey(env.api.Uri.file('/one/a.c')), catalog.projectKey(env.api.Uri.file('/two/a.c')));
    assert.equal(catalog.accepts(env.api.Uri.file('/usr/include/sdk.h')), true);
    assert.equal(catalog.accepts(env.api.Uri.file('/one/build/a.c')), false);
    env.settings.set('sourceInsightReader.excludedDirectories', ['../invalid']);
    assert.equal(catalog.accepts(env.api.Uri.file('/usr/include/sdk.h')), false);
  } finally { catalog.dispose(); }
});

test('external edits of every advertised language invalidate relation results', () => {
  const env = fakeVscode();
  const { connectEvents } = loadWithVscode(require.resolve('../src/application/events'), env.api);
  const subscriptions = [], disposable = { dispose() {} }; let invalidated = 0;
  const app = { disposables: [], localIndex: { onDidChange() { return disposable; } },
    catalog: { onDidChange(listener) { subscriptions.push(listener); return disposable; } },
    symbolView: { onDidChangeVisibility() { return disposable; }, onDidChangeSelection() { return disposable; } },
    relationView: { onDidChangeSelection() { return disposable; } },
    relationEngine: { invalidate() { invalidated++; } }, relations: { invalidate() {} }, references: { markStale() {} } };
  connectEvents(app);
  for (const name of ['caller.c', 'caller.H', 'Caller.java', 'caller.py', 'module.pyi']) {
    const before = invalidated;
    for (const listener of subscriptions) listener({ kind: 'change', uri: env.api.Uri.file('/project/' + name) });
    assert.equal(invalidated, before + 1, name);
  }
});

test('Worker retains per-file errors across unrelated updates, excludes stale targets and recovers', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-file-failures-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const worker = new Worker(path.join(__dirname, '../src/index-worker.js')); t.after(() => worker.terminate());
  let serial = 0; const pending = new Map();
  worker.on('message', message => {
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
  });
  const request = (action, data = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => reject(new Error('Worker timeout')), 10000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...data });
  });
  const files = ['a.c', 'b.c'].map(name => ({ uri: pathToFileURL(path.join(directory, name)).toString(), path: path.join(directory, name), project: directory }));
  await fs.writeFile(files[0].path, 'int alpha(void) { return 1; }');
  await fs.writeFile(files[1].path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('int beta(void) { return 2; }', 'utf16le')]));
  assert.equal((await request('scan', { files })).functions, 2);
  await fs.writeFile(files[1].path, ' '.repeat(8 * 1024 * 1024 + 1));
  const failed = await request('scan', { files });
  assert.equal(failed.failures.length, 1); assert.equal(failed.functions, 1);
  const updated = await request('update', { file: files[0] });
  assert.equal(updated.failures.length, 1); assert.equal(updated.failures[0].uri, files[1].uri);
  assert.deepEqual(await request('workspaceSymbols', { query: 'beta' }), []);
  await fs.writeFile(files[1].path, 'int recovered(void) { return 3; }');
  assert.equal((await request('update', { file: files[1] })).failures.length, 0);
  assert.equal((await request('workspaceSymbols', { query: 'recovered' })).length, 1);
  await fs.writeFile(files[1].path, Buffer.from([0xff]));
  assert.equal((await request('update', { file: files[1] })).failures.length, 1);
  assert.deepEqual(await request('workspaceSymbols', { query: 'recovered' }), []);
});
