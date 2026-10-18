'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('Context resolves functions to definitions, variables to types, explicit types accurately and missing definitions to declarations', async () => {
  const env = fakeVscode();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const doc = env.document('nav.c', 'struct Node { int value; };\nstruct Node make(void) { return (struct Node){0}; }\nstruct Node instance;');
  const loc = (line, a, b) => ({ uri: doc.uri, range: new env.api.Range(line, a, line, b) });
  const fn = loc(1, 12, 16), variable = loc(2, 12, 20), type = loc(0, 7, 11);
  let definition = fn, typeResult = [type];
  env.commands.set('vscode.executeDefinitionProvider', async () => definition ? [definition] : []);
  env.commands.set('vscode.executeTypeDefinitionProvider', async () => typeResult);
  env.commands.set('vscode.executeDeclarationProvider', async () => [fn]);
  env.commands.set('vscode.executeDocumentSymbolProvider', async () => [{ name: 'make', kind: 11,
    range: new env.api.Range(1, 0, 1, 58), selectionRange: fn.range }]);
  const adapter = new LanguageAdapter();
  const result = await adapter.contextDefinitions(doc.uri, fn.range.start);
  assert.equal(result.mode, '定义'); assert.equal(result.locations[0].range, fn.range);
  definition = variable;
  assert.equal((await adapter.contextDefinitions(doc.uri, variable.range.start)).locations[0].range, type.range);
  assert.equal((await adapter.contextDefinitions(doc.uri, variable.range.start, true)).mode, '类型定义');
  typeResult = [];
  assert.equal((await adapter.contextDefinitions(doc.uri, variable.range.start, true)).locations.length, 0);
  definition = undefined;
  assert.equal((await adapter.contextDefinitions(doc.uri, fn.range.start)).mode, '声明');
});

test('Context navigates using preview coordinates, keeps history and rejects old snapshots and changed buffers', async () => {
  const env = fakeVscode();
  const { ContextView } = loadWithVscode('../src/context', env.api);
  const doc = env.document('nav.c', 'void first() { second(); }\nvoid second() { third(); }\nvoid third() {}');
  const range = line => new env.api.Range(line, 5, line, 11);
  const queries = [];
  const view = new ContextView(env.context.extensionUri, { definitions: async (uri, pos) => {
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
