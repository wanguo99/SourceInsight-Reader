'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exportReferences, isExportReference, filterExportSymbols, correctExportTokens } = require('../src/infrastructure/c-export-references');
const { augmentDocumentSymbols } = require('../src/document-symbols');
const { normalizeSymbols } = require('../src/core');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const range = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } });
const source = 'int count;\nint exported(int x){return x + count;}\nEXPORT_SYMBOL(exported);\nEXPORT_SYMBOL_GPL(count);\nint run(void){return exported(count);}\n';
function providerSymbols(makeRange = range) {
  return [
    { name: 'count', kind: 12, range: makeRange(0, 0, 0, 10), selectionRange: makeRange(0, 4, 0, 9) },
    { name: 'exported', kind: 11, range: makeRange(1, 0, 1, 36), selectionRange: makeRange(1, 4, 1, 12) },
    { name: 'EXPORT_SYMBOL', kind: 14, range: makeRange(2, 0, 2, 24), selectionRange: makeRange(2, 0, 2, 13), children: [
      { name: 'exported', kind: 11, range: makeRange(2, 0, 2, 24), selectionRange: makeRange(2, 14, 2, 22) },
      { name: 'generated_export_address', kind: 12, range: makeRange(2, 0, 2, 24), selectionRange: makeRange(2, 0, 2, 13) }
    ] },
    { name: 'count', kind: 12, range: makeRange(3, 0, 3, 25), selectionRange: makeRange(3, 18, 3, 23) }
  ];
}

test('kernel export variants retain exact physical argument positions across lines and UTF-16 comments', () => {
  const text = '/* 😀 */ EXPORT_SYMBOL(\r\n  exported\r\n);\r\nEXPORT_SYMBOL_NS_GPL( /* note */ count, "CORE");\r\n' +
    'EXPORT_SYMBOL_FOR_MODULES(count, "test");\r\nEXPORT_PER_CPU_SYMBOL_GPL(count);';
  const values = exportReferences(text);
  assert.deepEqual(values.map(value => value.target), ['exported', 'count', 'count', 'count']);
  assert.deepEqual(values[0].targetRange, range(1, 2, 1, 10));
  assert.equal(values[0].range.start.character, text.split('\n')[0].indexOf('EXPORT_SYMBOL'));
  assert(isExportReference(values, { line: 1, character: 3 }, true));
});

test('export detection ignores comments, literals, macro definitions and real functions with similar names', () => {
  const text = '#define WRAP(x) \\\n EXPORT_SYMBOL(x)\n' +
    '// EXPORT_SYMBOL(fake);\nchar *s="EXPORT_SYMBOL(fake);";\n/* EXPORT_SYMBOL(fake); */\n' +
    'int EXPORT_SYMBOL(int arg) { return arg; }\nint EXPORT_SYMBOL_GPL(void);\n' +
    'SYSCALL_DEFINE1(genuine, int, value) { return value; }\nEXPORT_SYMBOL_CUSTOM(value);\n';
  assert.deepEqual(exportReferences(text), []);
});

test('semantic export expansions do not duplicate functions, variables or generated helpers in the outline', () => {
  const uri = 'file:///p/export.c', raw = providerSymbols(), before = structuredClone(raw);
  const filtered = filterExportSymbols(raw, exportReferences(source), uri);
  assert.deepEqual(filtered.map(node => node.name), ['count', 'exported']); assert.deepEqual(raw, before);
  const nodes = augmentDocumentSymbols(normalizeSymbols(raw, uri), source, uri, range);
  assert.deepEqual(nodes.map(node => node.name), ['count', 'exported']); assert(nodes.every(node => node.parent === undefined));
});

test('only export argument declaration flags are corrected; real definitions and semantic types stay intact', () => {
  const spans = [
    { line: 0, start: 4, end: 9, type: 'variable', modifiers: ['declaration', 'definition', 'static'] },
    { line: 2, start: 14, end: 22, type: 'function', modifiers: ['declaration', 'fileScope'] },
    { line: 3, start: 18, end: 23, type: 'variable', modifiers: ['definition', 'readonly'] }
  ], before = structuredClone(spans), corrected = correctExportTokens(spans, exportReferences(source));
  assert.deepEqual(corrected[0], spans[0]); assert.deepEqual(corrected[1].modifiers, ['fileScope']);
  assert.deepEqual(corrected[2].modifiers, ['readonly']); assert.equal(corrected[1].sourceReference, true);
  assert.equal(corrected[1].type, 'function'); assert.equal(corrected[2].type, 'variable'); assert.deepEqual(spans, before);
});

test('export references resolve to physical local definitions and do not introduce calls or bindings', async t => {
  const parser = await createParser(); t.after(() => parser.delete());
  const uri = 'file:///p/export.c', facts = parseC(parser, source, uri, '/p/export.c'), index = new CIndex(); index.replace([facts]);
  assert.deepEqual(facts.functions.map(node => node.name), ['exported', 'run']);
  assert.equal(facts.symbols.filter(node => node.name === 'count').length, 1);
  assert.equal(index.definitions(uri, { line: 2, character: 16 })[0].selectionRange.start.line, 1);
  assert.equal(index.definitions(uri, { line: 3, character: 20 })[0].selectionRange.start.line, 0);
  assert.deepEqual(facts.calls.map(call => call.name), ['exported']);
});

test('LanguageAdapter filters export symbols before persistence and rejects export-only definition targets', async t => {
  const env = fakeVscode(), document = env.document('export.c', source); document.languageId = 'c';
  const captured = [], local = { enabled: () => true, supports: () => true, log: () => {},
    symbols: async () => [], definitions: async () => [{ uri: document.uri, range: new env.api.Range(1, 4, 1, 12) }] };
  const indexStore = { observe: async (kind, uri, extra, action) => { const value = await action(); if (kind === 'symbols') captured.push(value); return value; } };
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api), language = new LanguageAdapter(local, undefined, indexStore); t.after(() => language.dispose());
  env.commands.set('vscode.executeDocumentSymbolProvider', async () => providerSymbols((...args) => new env.api.Range(...args)));
  const symbols = await language.symbols(document.uri);
  assert.deepEqual(symbols.map(node => node.name), ['count', 'exported']);
  assert.deepEqual(captured[0].map(node => node.name), ['count', 'exported']);
  env.commands.set('vscode.executeDefinitionProvider', async () => [{ uri: document.uri, range: new env.api.Range(2, 14, 2, 22) }]);
  const targets = await language.definitions(document.uri, new env.api.Position(4, 24));
  assert.equal(targets.length, 1); assert.equal(targets[0].range.start.line, 1); assert.equal(targets[0].provider, 'local');
  env.commands.set('vscode.executeDeclarationProvider', async () => [{ uri: document.uri, range: new env.api.Range(2, 14, 2, 22) }]);
  assert.deepEqual(await language.declarations(document.uri, new env.api.Position(4, 24)), []);
  let reads = 0;
  indexStore.descriptor = () => ({});
  indexStore.read = async () => { reads++; return providerSymbols((...args) => new env.api.Range(...args)); };
  indexStore.observe = async (kind, uri, extra, action) => { if (kind === 'symbols') throw new Error('provider offline'); return action(); };
  language.queries.invalidate();
  assert.deepEqual((await language.symbols(document.uri)).map(node => node.name), ['count', 'exported']);
  assert.equal(reads, 1, 'old persisted semantic expansions are filtered on cache replay too');
});
