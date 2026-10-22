'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('Context clicks navigate struct names in function return types and parameters without a language server', async () => {
  const { createParser, parseC } = require('../src/c-parser');
  const { CIndex } = require('../src/c-index');
  const env = fakeVscode(), cache = new Map();
  const load = name => loadWithVscode(require.resolve(name), env.api, cache);
  const header = env.document('sensor.h', 'struct bmc_sensor { int value; };\n');
  const source = env.document('sensor.c', '#include "sensor.h"\nstruct bmc_sensor *read_sensor(struct bmc_sensor *sensor) { return sensor; }\n');
  source.languageId = header.languageId = 'c';
  const parser = await createParser(), index = new CIndex();
  try { index.replace([header, source].map(document => parseC(parser, document.getText(), document.uri.toString(), document.uri.fsPath))); }
  finally { parser.delete(); }
  const language = new (load('../src/language').LanguageAdapter)({
    enabled: () => true, supports: () => true, log() {},
    definitions: async (uri, position) => index.definitions(uri.toString(), position).map(symbol => ({
      uri: env.api.Uri.parse(symbol.uri), range: new env.api.Range(symbol.selectionRange.start.line, symbol.selectionRange.start.character,
        symbol.selectionRange.end.line, symbol.selectionRange.end.character)
    }))
  });
  const view = new (load('../src/context').ContextView)(language, () => {});
  try {
    const line = source.lineAt(1).text;
    for (const character of [line.indexOf('bmc_sensor'), line.lastIndexOf('bmc_sensor')]) {
      await view.show({ uri: source.uri, range: new env.api.Range(1, 0, 1, 0) });
      await view.handleMessage({ action: 'navigate', snapshot: view.snapshot, line: 1, character });
      assert.equal(view.current.uri.toString(), header.uri.toString());
      assert.equal(view.current.range.start.line, 0);
      assert.equal(view.current.range.start.character, 7);
    }
    assert.equal(index.files.get(source.uri.toString()).calls.length, 0);
  } finally { view.dispose(); }
});

test('Context preserves variable definitions, resolves types explicitly and falls back to declarations', async () => {
  const env = fakeVscode();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const doc = env.document('nav.c', 'struct Node { int value; };\nstruct Node make(void) { return (struct Node){0}; }\nstruct Node instance;');
  const loc = (line, a, b) => ({ uri: doc.uri, range: new env.api.Range(line, a, line, b) });
  const fn = loc(1, 12, 16), variable = loc(2, 12, 20), type = loc(0, 7, 11);
  let definition = fn, typeResult = [type];
  let typeQueries = 0;
  env.commands.set('vscode.executeDefinitionProvider', async () => definition ? [definition] : []);
  env.commands.set('vscode.executeTypeDefinitionProvider', async () => { typeQueries++; return typeResult; });
  env.commands.set('vscode.executeDeclarationProvider', async () => [fn]);
  env.commands.set('vscode.executeDocumentSymbolProvider', async () => [{ name: 'make', kind: 11,
    range: new env.api.Range(1, 0, 1, 58), selectionRange: fn.range },
    { name: 'Node', kind: 22, range: new env.api.Range(0, 0, 0, 26), selectionRange: type.range }]);
  const adapter = new LanguageAdapter();
  const result = await adapter.contextDefinitions(doc.uri, fn.range.start);
  assert.equal(result.mode, '定义'); assert.equal(result.locations[0].range, fn.range);
  definition = variable;
  assert.equal((await adapter.contextDefinitions(doc.uri, variable.range.start)).locations[0].range, variable.range);
  assert.equal(typeQueries, 0);
  assert.equal((await adapter.contextDefinitions(doc.uri, variable.range.start, true)).mode, '类型定义');
  typeResult = [];
  assert.equal((await adapter.contextDefinitions(doc.uri, variable.range.start, true)).locations.length, 0);
  definition = undefined;
  assert.equal((await adapter.contextDefinitions(doc.uri, fn.range.start)).mode, '声明');
});

test('Context keeps field declarations instead of automatically following their element types', async () => {
  const env = fakeVscode();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const doc = env.document('result.h', 'struct bmc_point_sample { int value; };\n' +
    'struct bmc_collect_result { struct bmc_point_sample *samples; };');
  const field = { uri: doc.uri, range: new env.api.Range(1, 51, 1, 58) };
  const type = { uri: doc.uri, range: new env.api.Range(0, 7, 0, 23) };
  let typeQueries = 0;
  env.commands.set('vscode.executeDefinitionProvider', async () => [field]);
  env.commands.set('vscode.executeTypeDefinitionProvider', async () => { typeQueries++; return [type]; });
  const adapter = new LanguageAdapter();
  const result = await adapter.contextDefinitions(doc.uri, field.range.start);
  assert.equal(result.mode, '定义');
  assert.equal(result.locations[0].range, field.range);
  assert.equal(typeQueries, 0);
  assert.equal((await adapter.contextDefinitions(doc.uri, field.range.start, true)).locations[0].range, type.range);
  assert.equal(typeQueries, 1);
});

test('definition lookup still queries the language service when every local target is filtered out', async () => {
  const env = fakeVscode();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const source = env.document('main.c'), excluded = env.document('excluded.h'), target = env.document('target.h');
  const location = document => ({ uri: document.uri, range: new env.api.Range(0, 0, 0, 3) });
  let queries = 0;
  env.commands.set('vscode.executeDefinitionProvider', async () => { queries++; return [location(target)]; });
  const adapter = new LanguageAdapter({ enabled: () => true, supports: () => true,
    log() {}, definitions: async () => [location(excluded)] }, {
    accepts: uri => uri.toString() !== excluded.uri.toString()
  });
  const result = await adapter.contextDefinitions(source.uri, new env.api.Position(0, 0));
  assert.equal(result.locations[0].uri.toString(), target.uri.toString());
  assert.equal(queries, 1);
});

test('Context preserves scalar arrays/constants instead of following size_t, while explicit type lookup still works', async () => {
  const env = fakeVscode();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const doc = env.document('schema.h', 'typedef unsigned long size_t;\nstatic const size_t bmc_epdu_first[] = { 0, 155, 212 };');
  const array = { uri: doc.uri, range: new env.api.Range(1, 20, 1, 34) };
  const scalar = { uri: doc.uri, range: new env.api.Range(0, 22, 0, 28) };
  env.commands.set('vscode.executeDefinitionProvider', async () => [array]);
  env.commands.set('vscode.executeTypeDefinitionProvider', async () => [scalar]);
  env.commands.set('vscode.executeDocumentSymbolProvider', async () => [
    { name: 'size_t', kind: 4, range: new env.api.Range(0, 0, 0, 29), selectionRange: scalar.range },
    { name: 'bmc_epdu_first', kind: 12, range: new env.api.Range(1, 0, 1, 54), selectionRange: array.range }
  ]);
  const adapter = new LanguageAdapter();
  const result = await adapter.contextDefinitions(doc.uri, array.range.start);
  assert.equal(result.mode, '定义'); assert.equal(result.locations[0].range, array.range);
  const explicit = await adapter.contextDefinitions(doc.uri, array.range.start, true);
  assert.equal(explicit.mode, '类型定义'); assert.equal(explicit.locations[0].range, scalar.range);
});

test('Context navigates using preview coordinates, keeps history and rejects old snapshots and changed buffers', async () => {
  const env = fakeVscode();
  const { ContextView } = loadWithVscode('../src/context', env.api);
  const doc = env.document('nav.c', 'void first() { second(); }\nvoid second() { third(); }\nvoid third() {}');
  const range = line => new env.api.Range(line, 5, line, 11);
  const queries = [];
  const view = new ContextView({ definitions: async (uri, pos) => {
    queries.push({ uri, pos }); return [{ uri: doc.uri, range: range(pos.line + 1) }];
  } }, () => {});
  await view.show({ uri: doc.uri, range: range(0) });
  const first = view.snapshot;
  await view.handleMessage({ action: 'navigate', snapshot: first, line: 0, character: 15 });
  assert.equal(queries[0].pos.character, 15); assert.equal(view.current.range.start.line, 1);
  await view.handleMessage({ action: 'navigate', snapshot: first, line: 0, character: 15 });
  assert.equal(queries.length, 1);
  await view.handleMessage({ action: 'navigate', snapshot: view.snapshot, line: 1, character: 16 });
  assert.equal(view.current.range.start.line, 2);
  await view.handleMessage({ action: 'back' }); assert.equal(view.current.range.start.line, 1);
  await view.handleMessage({ action: 'forward' }); assert.equal(view.current.range.start.line, 2);
  doc.version++;
  await view.handleMessage({ action: 'navigate', snapshot: view.snapshot, line: 1, character: 16 });
  assert.equal(queries.length, 2); assert.match(view.state.status, /源码已修改/);
  await view.refresh();
  view.language.definitions = async () => [];
  await view.handleMessage({ action: 'navigate', snapshot: view.snapshot, line: 1, character: 16 });
  assert.equal(view.current.range.start.line, 2); assert.match(view.state.status, /保留原预览/);
  view.dispose();
});

test('activation selects the symbols view while preserving editor focus', async () => {
  const env = fakeVscode();
  const calls = [];
  env.commands.set('sourceInsightReader.symbols.focus', options => calls.push(options));
  const { ReadingController } = loadWithVscode('../src/extension', env.api);
  const controller = new ReadingController(env.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0].preserveFocus, true);
  controller.dispose();
});

test('Context applies C syntax colors in the actual preview without changing source text or editor position', async () => {
  const env = fakeVscode();
  const { ContextView } = loadWithVscode('../src/context', env.api);
  const text = '#include <stdint.h>\n#define BMC_LIMIT 32\nstruct Device { uint32_t value; };\nint run(struct Device *dev) { return dev->value + BMC_LIMIT; }';
  const doc = env.document('colors.c', text); doc.languageId = 'c';
  const editor = await env.api.window.showTextDocument(doc);
  const view = new ContextView({}, () => {});
  await view.show({ uri: doc.uri, range: new env.api.Range(3, 4, 3, 7) });
  assert.equal(env.api.window.activeTextEditor, editor);
  assert.equal(view.state.lines.map(line => line.tokens.map(token => token.text).join('')).join('\n'), text);
  const tokens = view.state.lines.flatMap(line => line.tokens);
  for (const [name, kind] of [['BMC_LIMIT', 'macro'], ['Device', 'type'], ['uint32_t', 'type'], ['run', 'function']]) {
    assert(tokens.some(token => token.text === name && token.kind === kind));
  }
  assert(tokens.some(token => token.text === 'value' && token.kind === 'property'));
  view.dispose();
});
