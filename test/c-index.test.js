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
  const base = path.join(os.tmpdir(), 'sourceinsight-reader-c-fixtures');
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
  assert(g.every(call => call.to.sourceInsightReaderLocal.unresolved));
  assert.equal(g.length, 3);
  const duplicate = index.calls(index.item(fn('use')), 'outgoing')[0];
  assert(duplicate.to.sourceInsightReaderLocal.unresolved); assert.match(duplicate.to.detail, /多个定义/);
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
  assert(index.calls(index.item(fn('other')), 'outgoing')[0].to.sourceInsightReaderLocal.unresolved);
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

test('local Worker queries serialize getter-backed VS Code positions without a language server', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceinsight-reader-position-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const headerPath = path.join(directory, 'types.h'), filePath = path.join(directory, 'main.c');
  const source = '#include "types.h"\nint leaf(void) { return 0; }\nint run(void) { return BMC_BACKOFF_UNSUPPORTED + leaf(); }\n';
  await fs.writeFile(headerPath, 'enum bmc_backoff_class { BMC_BACKOFF_UNSUPPORTED = 4 };\n');
  await fs.writeFile(filePath, source);
  const env = fakeVscode(), cache = new Map();
  env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file(directory), name: 'project' }];
  env.api.workspace.findFiles = async () => [headerPath, filePath].map(file => env.api.Uri.file(file));
  const load = name => loadWithVscode(require.resolve(name), env.api, cache);
  const catalog = new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
  const local = new (load('../src/local-index').LocalIndex)(env.context, catalog);
  t.after(() => { local.dispose(); catalog.dispose(); });
  class EditorPosition {
    constructor(line, character) { this._line = line; this._character = character; }
    get line() { return this._line; }
    get character() { return this._character; }
  }
  const line = source.split('\n')[2], uri = env.api.Uri.file(filePath);
  const enumPosition = new EditorPosition(2, line.indexOf('BMC_BACKOFF_UNSUPPORTED'));
  assert.equal(structuredClone(enumPosition).line, undefined);
  const language = new (load('../src/language').LanguageAdapter)(local, catalog);
  const result = await language.contextDefinitions(uri, enumPosition);
  assert.equal(result.locations.length, 1);
  assert.equal(result.locations[0].uri.toString(), env.api.Uri.file(headerPath).toString());
  const functionPosition = new EditorPosition(2, line.indexOf('leaf'));
  assert.equal((await local.definitions(uri, functionPosition))[0].range.start.line, 1);
  assert.equal((await local.prepare(uri, functionPosition))[0].name, 'leaf');
});

test('C definitions resolve enum constants and struct tags across guarded headers', async () => {
  const source = '#include "types.h"\nstruct bmc_sensor *sensor;\nint value = BMC_BACKOFF_BUSY;\n';
  const { index, facts } = await fixture({
    'types.h': '#ifndef TYPES_H\n#define TYPES_H\nenum bmc_backoff_class { BMC_BACKOFF_NONE = 0, BMC_BACKOFF_BUSY = 2 };\n' +
      '#ifdef __cplusplus\nextern "C" {\n#endif\nstruct bmc_sensor { int value; };\n#ifdef __cplusplus\n}\n#endif\n#endif\n',
    'use.c': source
  });
  for (const [name, line, kind] of [['bmc_sensor', 1, 22], ['BMC_BACKOFF_BUSY', 2, 21]]) {
    const definitions = index.definitions(facts[1].uri, { line, character: source.split('\n')[line].indexOf(name) });
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].name, name);
    assert.equal(definitions[0].kind, kind);
    assert.equal(definitions[0].uri, facts[0].uri);
    assert(index.workspaceSymbols(name).some(symbol => symbol.name === name));
  }
});

test('C definitions resolve globals, macros, typedefs and scoped local variables', async () => {
  const source = '#include "api.h"\nint run(int arg) {\nint local = arg;\n{ int local = LIMIT; local++; }\nreturn local + total;\n}\nAlias item;\n';
  const { index, facts } = await fixture({
    'api.h': '#define LIMIT 8\nextern int total;\ntypedef int Alias;\n',
    'use.c': source
  });
  const find = (line, name, last = false) => index.definitions(facts[1].uri, {
    line, character: last ? source.split('\n')[line].lastIndexOf(name) : source.split('\n')[line].indexOf(name)
  });
  assert.equal(find(2, 'arg')[0].selectionRange.start.line, 1);
  assert.equal(find(3, 'local', true)[0].selectionRange.start.line, 3);
  assert.equal(find(4, 'local')[0].selectionRange.start.line, 2);
  for (const [line, name] of [[3, 'LIMIT'], [4, 'total'], [6, 'Alias']]) {
    assert.equal(find(line, name)[0].uri, facts[0].uri);
    assert(index.workspaceSymbols(name).some(symbol => symbol.name === name));
  }
});

test('worker persists disk facts, overlays dirty documents, reloads cache and removes deleted files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceinsight-reader-index-'));
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
  await request('flush');
  assert.equal(JSON.parse(await fs.readFile(cachePath, 'utf8')).files[0].functions.length, 2);
  const restart = workerClient(t);
  assert.equal((await restart('scan', { files, cachePath })).functions, 2);
  await fs.writeFile(filePath, '\n' + source.replace('leaf() + leaf()', 'leaf()'));
  assert.equal((await restart('scan', { files, cachePath })).functions, 2);
  const moved = await restart('prepare', { uri, position: { line: 0, character: 5 }, name: 'leaf' });
  assert.equal(moved[0].selectionRange.start.line, 1);
  assert.equal((await restart('calls', { item: moved[0], direction: 'incoming' }))[0].fromRanges.length, 1);
  assert.equal((await restart('scan', { files: [], cachePath })).functions, 0);
  await restart('flush');
  assert.equal(JSON.parse(await fs.readFile(cachePath, 'utf8')).files.length, 0);
  await fs.writeFile(cachePath, '{bad json');
  assert.equal((await workerClient(t)('scan', { files, cachePath })).functions, 2);
});

test('Relation works without a provider, stalled symbol/type providers cannot block it, and cold empty calls retry', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceinsight-reader-relation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'sample.c');
  await fs.writeFile(filePath, 'static inline int helper(void) { return 1; }\nint run(void) { return helper(); }');
  const env = fakeVscode(), cache = new Map();
  const load = name => loadWithVscode(require.resolve(name), env.api, cache);
  env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file(dir), name: 'test' }];
  env.api.workspace.findFiles = async () => [env.api.Uri.file(filePath)];
  const { LocalIndex } = load('../src/local-index');
  const { LanguageAdapter } = load('../src/language');
  const { RelationSession } = load('../src/features/relation-session');
  const catalog = new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
  const local = new LocalIndex(env.context, catalog), language = new LanguageAdapter(local);
  t.after(() => { local.dispose(); catalog.dispose(); engine.dispose(); });
  const engine = load('../src/providers/create-relation-backend').createRelationBackend(local, catalog);
  const tree = new RelationSession(engine); t.after(() => tree.dispose());
  const source = { uri: env.api.Uri.file(filePath), range: new env.api.Range(0, 18, 0, 24), name: 'helper' };
  await tree.setRoot(source);
  assert.equal(tree.rootState.result.provider, 'local');
  const rows = (await tree.load(tree.root, 'incoming')).data; assert.equal(rows[0].symbol.name, 'run');
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
  const outgoing = await tree.load(tree.root, 'outgoing');
  assert.equal(outgoing.status, 'empty'); assert.match(outgoing.result.diagnostics.join(' '), /本地索引未找到直接调用/);

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
  const routing = facts.find(file => file.uri.endsWith('/libbmc/src/bmc/bmc_routing.c'));
  for (const line of [55, 108, 109]) {
    const text = (await fs.readFile(routing.path, 'utf8')).split('\n')[line];
    const field = index.definitions(routing.uri, { line, character: text.indexOf('samples') });
    assert.equal(field.length, 1);
    assert(field[0].uri.endsWith('/include/bmc/bmc/bmc_device.h'));
    assert.equal(field[0].selectionRange.start.line, 79, 'samples resolves to its field, not its element type');
  }
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
  const { RelationSession } = load('../src/features/relation-session'), { RelationPane } = load('../src/relation-pane');
  const local = new LocalIndex(env.context, new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)()), model = new RelationSession(load('../src/providers/create-relation-backend').createRelationBackend(local, local.catalog));
  const updates = [], errors = [];
  const pane = new RelationPane(model, () => ({ postMessage: state => updates.push(state) }), () => {}, error => errors.push(error));
  t.after(() => { pane.dispose(); model.dispose(); local.dispose(); });
  await model.setRoot({ uri: env.api.Uri.parse(fn.uri), range: fn.selectionRange, name: fn.name });
  // Foreground reading may start from a partial snapshot. Completeness checks
  // explicitly wait for the full revision; the controller subscribes in the app.
  await local.ensure(); await model.refresh();
  await pane.publish(); await model.whenIdle(); await new Promise(done => setImmediate(done));
  const graph = updates.at(-1).graph;
  const language = new LanguageAdapter(local, local.catalog);
  const enumSource = env.api.Uri.file(path.join(root, 'libbmc/src/bmc/bmc_backoff.c'));
  const enumResult = await language.contextDefinitions(enumSource, new env.api.Position(19, 9));
  assert.equal(enumResult.locations.length, 1);
  assert(enumResult.locations[0].uri.path.endsWith('/include/bmc/bmc/bmc_backoff.h'));
  assert.equal(enumResult.locations[0].range.start.line, 8);
  // Exercise Windows drive casing and CRLF independently of the host OS.
  const windowsFacts = facts.map(file => {
    const relative = path.relative(root, file.path).replace(/\\/g, '/');
    const uri = 'file:///C:/Code%20Reader/' + relative;
    const source = require('node:fs').readFileSync(file.path, 'utf8').replace(/\r?\n/g, '\r\n');
    return { ...parseC(parser, source, uri, 'C:\\Code Reader\\' + relative.replace(/\//g, '\\')), project: 'windows-project' };
  });
  const windowsIndex = new CIndex(); windowsIndex.replace(windowsFacts);
  const windowsDefinitions = windowsIndex.definitions('file:///c:/code%20reader/libbmc/src/bmc/bmc_backoff.c', { line: 19, character: 9 });
  assert.equal(windowsDefinitions.length, 1);
  assert.equal(windowsDefinitions[0].name, 'BMC_BACKOFF_UNSUPPORTED');
  assert.equal(graph.incomingCount, 29); assert.equal(graph.outgoingCount, 1);
  assert.equal(graph.incoming.reduce((total, row) => total + row.siteCount, 0), 66);
  assert.equal(graph.outgoing[0].label, 'bmc_string_copy_impl'); assert.equal(errors.length, 0);
});

test('a batch of new files commits one graph revision while retaining all functions', async t => {
  const request = workerClient(t), before = await request('scan', { files: [] });
  const files = Array.from({ length: 8 }, (_, at) => ({ file: { uri: `file:///project/new-${at}.c`, path: `/project/new-${at}.c`,
    text: `int function_${at}(void) { return ${at}; }` }, dirty: true }));
  const result = await request('updateBatch', { files });
  assert.equal(result.functions, 8); assert.equal(result.generation, before.generation + 1);
});

test('local facade indexes uppercase C/H files, reports coverage and revisions, and watches matching names', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceinsight-reader-uppercase-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = ['MAIN.C', 'TYPES.H'].map(name => path.join(dir, name));
  await fs.writeFile(files[0], 'int helper(void) { return 1; }\nint main(void) { return helper(); }');
  await fs.writeFile(files[1], 'int helper(void);');
  const env = fakeVscode(), patterns = [];
  env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file(dir), name: 'upper' }];
  env.api.workspace.findFiles = async pattern => { patterns.push(pattern); return files.map(file => env.api.Uri.file(file)); };
  const watcher = env.api.workspace.createFileSystemWatcher;
  env.api.workspace.createFileSystemWatcher = pattern => { patterns.push(pattern); return watcher(pattern); };
  const { LocalIndex } = loadWithVscode('../src/local-index', env.api);
  const local = new LocalIndex(env.context, new (loadWithVscode('../src/infrastructure/workspace-file-catalog', env.api).WorkspaceFileCatalog)()); t.after(() => local.dispose());
  const uri = env.api.Uri.file(files[0]); assert.equal(local.supports(uri), true); assert.equal(local.describe(uri).state, 'building');
  await local.ensure();
  assert.equal(local.describe(uri).state, 'ready'); assert(local.revision > 0);
  assert.equal(local.describe(env.api.Uri.file(path.join(dir, 'missing.c'))).state, 'notIndexed');
  const originalExclude = local.exclude;
  local.exclude = '**/MAIN.C'; assert.equal(local.describe(uri).state, 'excluded'); local.exclude = originalExclude;
  assert(patterns.includes('**/*.{c,C,h,H}') && patterns.includes('**/*'));
  const roots = await local.prepare(uri, new env.api.Position(0, 5), 'helper');
  assert.equal(roots[0].name, 'helper'); assert.equal((await local.calls(roots[0], 'incoming'))[0].from.name, 'main');
  const revision = local.revision; await local.refresh(); assert(local.revision > revision);
});

test('controller recovers automatically when an initially cold local C index completes', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sourceinsight-reader-controller-'));
  const file = path.join(dir, 'calls.c');
  await fs.writeFile(file, 'int helper(void) { return 1; }\nint run(void) { return helper(); }');
  const env = fakeVscode();
  env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file(dir), name: 'project' }];
  env.api.workspace.findFiles = async () => [env.api.Uri.file(file)];
  const { ReadingController } = loadWithVscode('../src/extension', env.api);
  const document = env.document('calls.c', await fs.readFile(file, 'utf8'));
  env.documents.delete(document.uri.toString()); document.uri = env.api.Uri.file(file); document.languageId = 'c';
  env.documents.set(document.uri.toString(), document); env.api.workspace.textDocuments = [document];
  const editor = await env.api.window.showTextDocument(document);
  const controller = new ReadingController(env.context);
  await controller.follow.acceptEditor(editor);
  t.after(async () => { controller.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  const source = { uri: env.api.Uri.file(file), range: new env.api.Range(0, 4, 0, 10), name: 'helper' };
  await controller.relations.setRoot(source);
  const deadline = Date.now() + 3000;
  while ((!controller.relations.root || controller.relations.rootState.status !== 'ready') && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(controller.relations.rootState.result.provider, 'local');
  const children = await controller.relations.load(controller.relations.root, 'incoming');
  assert.equal(children.data[0].symbol.name, 'run'); assert.equal(children.result.provider, 'local');
});

test('incremental graph updates equal a fresh rebuild after header, macro, static and definition changes', async t => {
  const parser = await createParser(); t.after(() => parser.delete());
  const root = path.join(os.tmpdir(), 'reader-incremental');
  const texts = new Map([
    ['api.h', 'static int helper(void) { return 1; }'],
    ['bridge.h', '#include "api.h"'],
    ['a.c', '#include "bridge.h"\nint run(void) { return helper() + shared(); }'],
    ['b.c', 'int shared(void) { return 1; }\nint other(void) { return shared(); }']
  ]);
  const facts = new Map([...texts].map(([name, text]) => [name, parseC(parser, text, pathToFileURL(path.join(root, name)).toString(), path.join(root, name))]));
  const incremental = new CIndex(); incremental.replace([...facts.values()]);
  const snapshot = index => [...index.functions.values()].map(fn => ({ name: fn.name, uri: fn.uri,
    incoming: index.calls(index.item(fn), 'incoming'), outgoing: index.calls(index.item(fn), 'outgoing') })).map(value => JSON.parse(JSON.stringify(value), (key, item) => key === 'generation' ? undefined : item)).sort((a, b) => (a.uri + a.name).localeCompare(b.uri + b.name));
  const edits = [
    ['api.h', '#define helper() 0\nstatic int helper(void) { return 2; }'],
    ['api.h', '\nstatic int helper(void) { return 2; }'],
    ['b.c', 'int renamed(void) { return 1; }\nint other(void) { return renamed(); }'],
    ['bridge.h', '/* header removed */'],
    ['a.c', '#include "api.h"\nstatic int shared(void) { return 3; }\nint run(void) { return shared() + helper(); }'],
    ['new.c', 'int shared(void) { return 8; }'],
    ['api.h', 'int helper(void) { return 3; }']
  ];
  for (const [name, text] of edits) {
    const file = path.join(root, name), value = parseC(parser, text, pathToFileURL(file).toString(), file);
    facts.set(name, value); incremental.update(value); const rebuilt = new CIndex(); rebuilt.replace([...facts.values()]);
    assert.deepEqual(snapshot(incremental), snapshot(rebuilt), name);
  }
  incremental.remove(facts.get('new.c').uri); facts.delete('new.c'); const rebuilt = new CIndex(); rebuilt.replace([...facts.values()]); assert.deepEqual(snapshot(incremental), snapshot(rebuilt));
});

test('index status distinguishes creation, queued incremental updates, completion and errors', async t => {
  const env = fakeVscode(), load = name => loadWithVscode(require.resolve(name), env.api);
  const { WorkspaceFileCatalog } = load('../src/infrastructure/workspace-file-catalog'), { LocalIndex } = load('../src/local-index');
  const catalog = new WorkspaceFileCatalog(), index = new LocalIndex(env.context, catalog);
  t.after(() => { index.dispose(); catalog.dispose(); });
  index.beginUpdate(); assert.equal(index.getStatus().operation, 'creating'); assert.match(index.getStatus().message, /索引创建中/); assert.equal(index.getStatus().busy, true);
  index.summary = { files: 10, functions: 20, calls: 30 }; index.report(); assert.equal(index.getStatus().phase, 'ready');
  index.beginUpdate(); assert.equal(index.getStatus().operation, 'updating'); assert.match(index.getStatus().message, /索引更新中/);
  index.request = async () => { throw new Error('disk unavailable'); }; await assert.rejects(index.updateRequest('update', {}));
  assert.equal(index.getStatus().phase, 'error'); assert.equal(index.getStatus().busy, false); assert.match(index.getStatus().message, /disk unavailable/);
});

test('workspace symbol search finds C declarations, macros, records and fields without a language server', async () => {
  const { index } = await fixture({ 'symbols.c': '#define BUFFER_SIZE 32\nstruct DeviceState { int ready; };\nint global_count;\nint bmc_string_copy(void) { return 0; }' });
  assert.equal(index.workspaceSymbols('copy str')[0].name, 'bmc_string_copy');
  for (const name of ['BUFFER_SIZE', 'DeviceState', 'ready', 'global_count']) {
    const values = index.workspaceSymbols(name); assert(values.some(item => item.name === name), name);
    assert(values[0].uri.endsWith('symbols.c')); assert(values[0].range.start);
  }
});
test('multi-root projects isolate same-name global functions and header suffixes', async () => {
  const { index, facts, fn } = await fixture({
    'one/a.c': '#include "inline.h"\nint helper(void) { return 1; }\nint main_one(void) { return helper() + shared(); }',
    'one/inline.h': 'static inline int shared(void) { return 1; }',
    'two/b.c': '#include "inline.h"\nint helper(void) { return 2; }\nint main_two(void) { return helper() + shared(); }',
    'two/inline.h': 'static inline int shared(void) { return 2; }',
    'one/use.c': 'int use(void) { return helper(); }'
  });
  for (const file of facts) file.project = file.uri.includes('/one/') ? 'one' : 'two';
  index.replace(facts);
  const use = index.calls(index.item(fn('use')), 'outgoing'); assert.equal(use[0].to.uri, fn('helper', 'one/a.c').uri);
  const calls = index.calls(index.item(fn('main_one')), 'outgoing');
  assert.equal(calls.find(call => call.to.name === 'shared').to.uri, fn('shared', 'one/inline.h').uri);
  assert.equal(index.calls(index.item(fn('helper', 'two/b.c')), 'incoming').length, 1);
});
test('call diagnostics disclose indirect calls and unresolved direct targets', async () => {
  const { index, fn } = await fixture({ 'a.c': 'int run(int (*callback)(void)) { return callback() + unknown(); }' });
  const notes = index.callDiagnostics(index.item(fn('run')), 'outgoing').join(';');
  assert.match(notes, /1 处间接调用/); assert.match(notes, /1 处直接调用目标/); assert.match(notes, /条件分支未求值/);
});
