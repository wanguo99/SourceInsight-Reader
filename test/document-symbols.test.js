'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { preprocessorSymbols, augmentDocumentSymbols, symbolCategory } = require('../src/document-symbols');
const { normalizeSymbols, filterSymbols } = require('../src/core');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const uri = 'file:///C:/Project/outline.c';
const range = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } });

test('C preprocessor outline includes headers and object/function/multiline macros with exact CRLF positions', () => {
  const text = '#include "中文 file.h"\r\n#include <stdint.h>\r\n#include HEADER_FILE\r\n#define LIMIT 16\r\n#define DOUBLE(x) ((x)*2)\r\n#define SUM(x) \\\r\n ((x) + LIMIT)\r\n';
  const nodes = preprocessorSymbols(text, uri, range);
  assert.deepEqual(nodes.map(node => node.name), ['#include "中文 file.h"', '#include <stdint.h>', '#include HEADER_FILE', 'LIMIT', 'DOUBLE', 'SUM']);
  assert.equal(nodes[0].selectionRange.start.character, text.split('\r\n')[0].indexOf('中文'));
  assert.equal(nodes[0].selectionRange.end.character - nodes[0].selectionRange.start.character, '中文 file.h'.length);
  assert.equal(nodes[5].range.end.line, 6);
  assert.equal(nodes[5].selectionRange.start.line, 5);
  assert.equal(nodes[5].selectionRange.end.line, 5);
  assert.equal(nodes[5].origin, 'source');
});

test('outline ignores fake directives in comments, raw strings and continued line comments/macro bodies', () => {
  const text = [
    '/*', '#define COMMENT_FAKE 1', '*/',
    'const char *text = R"tag(', '#include "raw_fake.h"', ')tag";',
    '// comment \\', '#define CONTINUED_COMMENT_FAKE 1',
    '#define BODY \\', '  "text" \\', '  #define BODY_FAKE 1',
    '/* leading comment */ # define REAL 42',
    '#include /* note */ "real.h"'
  ].join('\n');
  const nodes = preprocessorSymbols(text, uri, range);
  assert.deepEqual(nodes.map(node => node.name), ['BODY', 'REAL', '#include "real.h"']);
});

test('inactive conditional directives are retained as physical entries, without evaluating build conditions', () => {
  const nodes = preprocessorSymbols('#if 0\n#define INACTIVE 1\n#endif\n', uri, range);
  assert.equal(nodes[0].name, 'INACTIVE');
  assert.equal(nodes[0].origin, 'source');
});

test('semantic globals/structs stay hierarchical; macro merge does not duplicate provider entries', () => {
  const nodes = normalizeSymbols([
    { name: 'LIMIT', kind: 11, range: range(1, 0, 1, 16), selectionRange: range(1, 8, 1, 13) },
    { name: 'count', kind: 12, range: range(2, 0, 2, 14), selectionRange: range(2, 4, 2, 9) },
    { name: 'Device', kind: 22, range: range(3, 0, 6, 2), selectionRange: range(3, 7, 3, 13), children: [
      { name: 'id', kind: 7, range: range(4, 2, 4, 8), selectionRange: range(4, 6, 4, 8) }
    ] },
    { name: 'run', kind: 11, range: range(7, 0, 7, 18), selectionRange: range(7, 4, 7, 7) }
  ], uri);
  const enriched = augmentDocumentSymbols(nodes, '#include "a.h"\n#define LIMIT 16\nint count = 0;\n', uri, range);
  assert.equal(enriched.filter(node => node.name === 'LIMIT').length, 1);
  assert.equal(enriched.find(node => node.name === 'LIMIT').category, 'macro');
  assert.equal(symbolCategory(enriched.find(node => node.name === 'count')), '全局变量');
  assert.equal(symbolCategory(enriched.find(node => node.name === 'Device')), '结构体');
  const all = filterSymbols(enriched, '', 'position', undefined, true);
  assert.equal(all.find(node => node.name === 'Device').children[0].parent, all.find(node => node.name === 'Device'));
  assert.deepEqual(filterSymbols(enriched).map(node => node.name), ['run']);
});

test('LanguageAdapter and default file-symbol tree expose C includes, macros, globals and structures together', async () => {
  const env = fakeVscode(), cache = new Map();
  const load = file => loadWithVscode(require.resolve(file), env.api, cache);
  const { LanguageAdapter } = load('../src/language');
  const { SymbolTree } = load('../src/trees');
  const doc = env.document('outline.c', '#include "a.h"\n#define LIMIT 16\nint count;\nstruct Device {int id;};\n'); doc.languageId = 'c';
  env.commands.set('vscode.executeDocumentSymbolProvider', async () => [
    { name: 'count', kind: 12, range: new env.api.Range(2, 0, 2, 10), selectionRange: new env.api.Range(2, 4, 2, 9) },
    { name: 'Device', kind: 22, range: new env.api.Range(3, 0, 3, 24), selectionRange: new env.api.Range(3, 7, 3, 13) }
  ]);
  const tree = new SymbolTree(new LanguageAdapter());
  await tree.load(doc.uri);
  const nodes = tree.getChildren();
  assert.deepEqual(nodes.map(node => node.name), ['#include "a.h"', 'LIMIT', 'count', 'Device']);
  assert.ok(tree.getTreeItem(nodes[1]).description.includes('宏定义'));
  assert.ok(tree.getTreeItem(nodes[2]).description.includes('全局变量'));
  assert.equal(tree.getTreeItem(nodes[0]).command.arguments[0].selectionRange.start.line, 0);
  tree.allSymbols = false; tree.refresh();
  assert.ok(tree.getChildren()[0].label.includes('全部符号'));
  tree.dispose();
});

test('non-C language providers are not scanned for C preprocessor-looking text', async () => {
  const env = fakeVscode();
  const { LanguageAdapter } = loadWithVscode(require.resolve('../src/language'), env.api);
  const doc = env.document('sample.py', '#define NOT_A_MACRO 1\n'); doc.languageId = 'python';
  assert.deepEqual(await new LanguageAdapter().symbols(doc.uri), []);
});
