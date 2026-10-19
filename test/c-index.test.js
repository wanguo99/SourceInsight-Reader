'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

async function fixture(sources) {
  const parser = await createParser();
  const base = path.join(os.tmpdir(), 'source-reader-c-fixtures');
  const facts = Object.entries(sources).map(([name, text]) => {
    const file = path.join(base, name);
    return parseC(parser, text, pathToFileURL(file).toString(), file);
  });
  parser.delete();
  const index = new CIndex(); index.replace(facts);
  const fn = (name, file) => [...index.functions.values()].find(fn => fn.name === name && (!file || fn.uri.endsWith(file)));
  return { index, facts, fn };
}

test('C index isolates static functions and follows included static-inline definitions with exact call sites', async () => {
  const { index, fn } = await fixture({
    'include/shared.h': 'static inline int shared(void) { return 1; }',
    'a.c': '#include "shared.h"\nstatic int helper(void) { return shared(); }\nint a(void) { return helper() + helper(); }',
    'b.c': 'static int helper(void) { return 2; }\nint b(void) { return helper(); }',
    'not-included.h': 'static int shared(void) { return 9; }'
  });
  const a = index.calls(index.item(fn('helper', 'a.c')), 'incoming');
  const b = index.calls(index.item(fn('helper', 'b.c')), 'incoming');
  assert.deepEqual(a.map(call => call.from.name), ['a']); assert.equal(a[0].fromRanges.length, 2);
  assert.deepEqual(b.map(call => call.from.name), ['b']);
  const shared = index.calls(index.item(fn('shared', 'shared.h')), 'incoming');
  assert.equal(shared.length, 1); assert.equal(shared[0].from.name, 'helper');
  const outgoing = index.calls(index.item(fn('helper', 'a.c')), 'outgoing')[0];
  assert.equal(outgoing.to.uri, fn('shared', 'shared.h').uri);
  assert.equal(outgoing.to.selectionRange.start.line, 0);
  assert.equal(outgoing.fromRanges[0].start.line, 1);
});

test('C index keeps macro candidates, conditional duplicates, callbacks and indirect calls conservative', async () => {
  const { index, fn, facts } = await fixture({
    'a.c': '#define ALIAS(x) real(x)\nint real(int n) { return n; }\n' +
      'int f(void) { int (*real)(int) = 0; return real(1); }\n' +
      'int g(void) { register_cb(real); return ALIAS(1) + external(); }\n' +
      '#ifdef FLAG\nint duplicate(void) { return 1; }\n#else\nint duplicate(void) { return 2; }\n#endif\n' +
      'int use(void) { return duplicate(); }\n'
  });
  assert.equal(index.calls(index.item(fn('real')), 'incoming').length, 0);
  assert.equal(index.calls(index.item(fn('f')), 'outgoing').length, 0);
  const indirect = facts[0].calls.find(call => call.indirect && call.name === 'real');
  assert.equal(index.prepare(facts[0].uri, indirect.range.start, 'real').length, 0);
  const g = index.calls(index.item(fn('g')), 'outgoing');
  assert(g.every(call => call.to.sourceReaderLocal.unresolved));
  assert.equal(g.length, 3);
  const duplicate = index.calls(index.item(fn('use')), 'outgoing')[0];
  assert(duplicate.to.sourceReaderLocal.unresolved); assert.match(duplicate.to.detail, /多个定义/);
  const call = facts[0].calls.find(call => call.name === 'duplicate');
  assert.equal(index.prepare(facts[0].uri, call.range.start).length, 2);
});

test('C parser ignores comments and strings, retains nested calls and UTF-16 CRLF locations', async () => {
  const source = '/* 😀 中 */ int leaf(void) { return 1; }\r\n' +
    '/*\n#define FAKE 1\n#include "fake.h"\nint fake(void) { bad(); }\n*/\r\n' +
    'int caller(void) { const char *s="leaf()"; return wrapper(leaf()) + leaf(); }\r\n';
  const { index, facts, fn } = await fixture({ '中文 file.c': source });
  assert.equal(facts[0].functions.length, 2); assert.equal(facts[0].includes.length, 0); assert.equal(facts[0].macros.length, 0);
  assert.equal(fn('leaf').selectionRange.start.character, source.split('\r\n')[0].indexOf('leaf'));
  const incoming = index.calls(index.item(fn('leaf')), 'incoming');
  assert.equal(incoming.length, 1); assert.equal(incoming[0].fromRanges.length, 2);
  for (const range of incoming[0].fromRanges) {
    assert.equal(source.split('\n')[range.start.line].slice(range.start.character, range.end.character), 'leaf');
  }
  const name = fn('caller').selectionRange.start;
  assert.deepEqual(index.definitions(facts[0].uri, name).map(fn => fn.name), ['caller']);
  assert.equal(index.definitions(facts[0].uri, { line: name.line, character: 40 }).length, 0);
});

test('include ambiguity and transitive headers do not select arbitrary static definitions', async () => {
  const { index, fn } = await fixture({
    'one/common.h': 'static int hidden(void) { return 1; }',
    'two/common.h': 'static int hidden(void) { return 2; }',
    'bridge.h': '#include "one/common.h"',
    'consumer.c': '#include "bridge.h"\nint run(void) { return hidden(); }',
    'ambiguous.c': '#include "common.h"\nint other(void) { return hidden(); }'
  });
  assert.equal(index.calls(index.item(fn('run')), 'outgoing')[0].to.uri, fn('hidden', 'one/common.h').uri);
  assert(index.calls(index.item(fn('other')), 'outgoing')[0].to.sourceReaderLocal.unresolved);
  assert.deepEqual(index.calls(index.item(fn('hidden', 'one/common.h')), 'incoming').map(call => call.from.name), ['run']);
});

test('local outline retains declarations, aggregate members, aliases, globals and function pointers', async () => {
  const { index, facts } = await fixture({
    'api.h': 'struct Node { int value; struct Node *next; };\ntypedef struct Node Node;\n' +
      'union Value { int number; char *text; };\nenum Mode { OFF, ON };\n' +
      'extern int count;\nstatic int values[] = {1,2};\nint (*callback)(int);\nint api(int value);\n' +
      'typedef struct { int member; } Anonymous;\n',
    'api.c': '#include "api.h"\nint api(int value) { return value; }'
  });
  const symbols = index.symbols(facts[0].uri);
  for (const name of ['Node', 'Value', 'Mode', 'count', 'values', 'callback', 'api']) assert(symbols.some(symbol => symbol.name === name), name);
  assert(symbols.find(symbol => symbol.name === 'Node' && symbol.kind === 22).children.some(field => field.name === 'next'));
  assert(symbols.find(symbol => symbol.name === 'Mode').children.some(field => field.name === 'ON'));
  assert.equal(symbols.find(symbol => symbol.name === 'callback').kind, 12);
  assert.equal(symbols.find(symbol => symbol.name === 'Anonymous').kind, 22);
  assert.equal(symbols.find(symbol => symbol.name === 'Anonymous').children[0].name, 'member');
  const declaration = facts[0].declarations.find(declaration => declaration.name === 'api');
  assert.equal(index.prepare(facts[0].uri, declaration.range.start)[0].uri, facts[1].uri);
});

function workerClient(t) {
  const worker = new Worker(path.join(__dirname, '../src/index-worker.js'));
  let serial = 0; const pending = new Map();
  worker.on('message', message => {
    if (!message.id) return;
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.result);
  });
  worker.on('error', error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  });
  t.after(() => worker.terminate());
  return (action, data = {}) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker test timeout')); }, 10000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...data });
  });
}

test('worker persists disk facts, overlays dirty documents, reloads cache and removes deleted files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-reader-index-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, '空 格.c'), uri = pathToFileURL(filePath).toString();
  const source = 'int leaf(void) { return 1; }\nint run(void) { return leaf() + leaf(); }';
  await fs.writeFile(filePath, source);
  const cachePath = path.join(dir, 'cache', 'index.json');
  const files = [{ uri, path: filePath }], request = workerClient(t);
  assert.equal((await request('scan', { files, cachePath })).functions, 2);
  const roots = await request('prepare', { uri, position: { line: 0, character: 5 } });
  assert.equal((await request('calls', { item: roots[0], direction: 'incoming' }))[0].fromRanges.length, 2);
  await request('update', { file: { uri, path: filePath, text: 'int leaf(void) { return 2; }' }, dirty: true });
  assert.equal((await request('calls', { item: roots[0], direction: 'incoming' })).length, 0);
  assert.equal(JSON.parse(await fs.readFile(cachePath, 'utf8')).files[0].functions.length, 2);
  const restart = workerClient(t);
  assert.equal((await restart('scan', { files, cachePath })).functions, 2);
  await fs.writeFile(filePath, '\n' + source.replace('leaf() + leaf()', 'leaf()'));
  assert.equal((await restart('scan', { files, cachePath })).functions, 2);
  const moved = await restart('prepare', { uri, position: { line: 0, character: 5 }, name: 'leaf' });
  assert.equal(moved[0].selectionRange.start.line, 1);
  assert.equal((await restart('calls', { item: moved[0], direction: 'incoming' }))[0].fromRanges.length, 1);
  assert.equal((await restart('scan', { files: [], cachePath })).functions, 0);
  assert.equal(JSON.parse(await fs.readFile(cachePath, 'utf8')).files.length, 0);
  await fs.writeFile(cachePath, '{bad json');
  assert.equal((await workerClient(t)('scan', { files, cachePath })).functions, 2);
});

test('Relation works without a provider, stalled symbol/type providers cannot block it, and cold empty calls retry', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-reader-relation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'sample.c');
  await fs.writeFile(filePath, 'static inline int helper(void) { return 1; }\nint run(void) { return helper(); }');
  const env = fakeVscode(), cache = new Map();
  const load = name => loadWithVscode(require.resolve(name), env.api, cache);
  env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file(dir), name: 'test' }];
  env.api.workspace.findFiles = async () => [env.api.Uri.file(filePath)];
  const { LocalIndex } = load('../src/local-index');
  const { LanguageAdapter } = load('../src/language');
  const { RelationTree } = load('../src/trees');
  const local = new LocalIndex(env.context), language = new LanguageAdapter(local);
  t.after(() => local.dispose());
  const tree = new RelationTree(language); t.after(() => tree.dispose());
  const source = { uri: env.api.Uri.file(filePath), range: new env.api.Range(0, 18, 0, 24), name: 'helper' };
  await tree.setRoot(source);
  assert(tree.root.item.sourceReaderLocal);
  const rows = await tree.getChildren(tree.root); assert.equal(rows[0].name, 'run');
  assert.equal(rows[0].sites[0].range.start.line, 1);
  const definition = await language.definitions(source.uri, new env.api.Position(1, 24));
  assert.equal(definition[0].range.start.line, 0);
  const document = env.document('sample.c', 'static inline int helper(void) { return 1; }\nint run(void) { return helper(); }');
  document.uri = source.uri; env.documents.set(source.uri.toString(), document);
  env.api.workspace.textDocuments = [document];
  env.commands.set('vscode.executeDocumentSymbolProvider', () => new Promise(() => {}));
  env.commands.set('vscode.executeTypeDefinitionProvider', () => new Promise(() => {}));
  const symbols = await language.symbols(source.uri);
  assert(symbols.some(symbol => symbol.name === 'helper'));
  assert.equal((await language.contextDefinitions(source.uri, new env.api.Position(1, 24))).locations[0].range.start.line, 0);
  document.text = '\nstatic inline int helper(void) { return 1; }\nint run(void) { return helper(); }';
  document.version++; document.isDirty = true;
  assert.equal((await language.definitions(source.uri, new env.api.Position(2, 24)))[0].range.start.line, 1);
  tree.switchDirection('outgoing');
  assert.match((await tree.getChildren(tree.root))[0].label, /本地索引未找到直接调用/);
  let count = 0;
  const cold = new RelationTree({ prepare: async () => [{ name: 'helper', uri: source.uri, range: source.range, selectionRange: source.range }],
    calls: async () => ++count === 1 ? [] : [{ from: { name: 'run', uri: source.uri, selectionRange: new env.api.Range(1, 4, 1, 7) }, fromRanges: [new env.api.Range(1, 23, 1, 29)] }] });
  t.after(() => cold.dispose());
  await cold.setRoot(source); await cold.getChildren(cold.root);
  assert.equal((await cold.getChildren(cold.root))[0].name, 'run');
  await cold.getChildren(cold.root); assert.equal(count, 2);
  cold.language.prepare = async () => { throw new Error('temporary outage'); };
  await cold.setRoot(source); assert(cold.retained); assert.equal((await cold.getChildren(cold.root))[0].name, 'run');
});

test('libbmc nullable string helper has all 66 direct occurrences without clangd', async t => {
  const root = path.resolve(__dirname, '../../source-example');
  try { await fs.access(root); } catch { t.skip('Optional user source-example is not present'); return; }
  const parser = await createParser(); t.after(() => parser.delete());
  const facts = [];
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['.git', '.cache', 'build', 'dist', 'out', 'node_modules'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(c|h)$/.test(file)) facts.push(parseC(parser, await fs.readFile(file, 'utf8'), pathToFileURL(file).toString(), file));
    }
  };
  await walk(root);
  const index = new CIndex(); index.replace(facts);
  const fn = [...index.functions.values()].find(fn => fn.name === 'bmc_string_copy_nullable');
  assert(fn); assert.equal(fn.selectionRange.start.line, 27);
  const callers = index.calls(index.item(fn), 'incoming');
  assert.equal(callers.length, 29); assert.equal(callers.reduce((sum, call) => sum + call.fromRanges.length, 0), 66);
  for (const caller of callers) {
    const file = facts.find(file => file.uri === caller.from.uri);
    const text = await fs.readFile(file.path, 'utf8');
    for (const range of caller.fromRanges) assert.equal(text.split('\n')[range.start.line].slice(range.start.character, range.end.character), fn.name);
  }
  const outgoing = index.calls(index.item(fn), 'outgoing');
  assert.equal(outgoing[0].to.name, 'bmc_string_copy_impl'); assert.equal(outgoing[0].to.selectionRange.start.line, 14);
  const query = [...index.functions.values()].find(fn => fn.name === 'bmc_epdu_query_decode');
  const parse = index.calls(index.item(query), 'outgoing').find(call => call.to.name === 'bmc_epdu_frame_parse');
  assert.equal(parse.to.selectionRange.start.line, 45); assert.equal(parse.fromRanges[0].start.line, 169);
  // Exercise the real Worker -> adapter -> model -> horizontal view protocol,
  // with no semantic provider installed, using the user's regression project.
  const env = fakeVscode(), cache = new Map();
  const load = name => loadWithVscode(require.resolve(name), env.api, cache);
  env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file(root), name: 'libbmc' }];
  env.api.workspace.findFiles = async () => facts.map(file => env.api.Uri.parse(file.uri));
  const { LocalIndex } = load('../src/local-index'), { LanguageAdapter } = load('../src/language');
  const { RelationTree } = load('../src/trees'), { RelationPane } = load('../src/relation-pane');
  const local = new LocalIndex(env.context), model = new RelationTree(new LanguageAdapter(local));
  const updates = [], errors = [];
  const pane = new RelationPane(model, () => ({ postMessage: state => updates.push(state) }), () => {}, error => errors.push(error));
  t.after(() => { pane.dispose(); model.dispose(); local.dispose(); });
  await model.setRoot({ uri: env.api.Uri.parse(fn.uri), range: fn.selectionRange, name: fn.name });
  await pane.publish();
  const graph = updates.at(-1).graph;
  assert.equal(graph.incomingCount, 29); assert.equal(graph.outgoingCount, 1);
  assert.equal(graph.incoming.reduce((total, row) => total + row.siteCount, 0), 66);
  assert.equal(graph.outgoing[0].label, 'bmc_string_copy_impl'); assert.equal(errors.length, 0);
});
