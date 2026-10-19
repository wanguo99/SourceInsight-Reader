'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { highlightLine } = require('../src/syntax');

test('preview syntax preserves exact source while identifying types, calls, strings and comments', () => {
  const source = 'const int result = leaf(42); // <script>alert("x")</script>';
  const tokens = highlightLine(source);
  assert.equal(tokens.map(token => token.text).join(''), source);
  assert.ok(tokens.some(token => token.kind === 'keyword' && token.text === 'const'));
  assert.ok(tokens.some(token => token.kind === 'function' && token.text === 'leaf'));
  assert.ok(tokens.some(token => token.kind === 'comment' && token.text.includes('<script>')));
});

test('C++ comments and raw strings carry state across CRLF source lines', () => {
  const state = { block: false, rawEnd: '' };
  const lines = ['/* comment', 'continued */ int value = 0;', 'auto text = R"tag(<div>', 'raw /* not a comment */)tag";'];
  const output = lines.map(line => highlightLine(line, state));
  assert.ok(output[1].some(token => token.kind === 'type' && token.text === 'int'));
  assert.equal(output[3][0].kind, 'string'); assert.equal(state.rawEnd, '');
  assert.equal(output.map(tokens => tokens.map(token => token.text).join('')).join('\r\n'), lines.join('\r\n'));
});

test('unsupported languages and very long lines retain unmodified plain text', () => {
  const source = 'if value: return "a"';
  assert.deepEqual(highlightLine(source, undefined, 'python'), [{ text: source, kind: 'plain' }]);
  const long = 'a'.repeat(21000);
  assert.deepEqual(highlightLine(long), [{ text: long, kind: 'plain' }]);
});

test('C previews distinguish directives, macro bodies, types, fields, literals and continued strings', () => {
  const state = { block: false, rawEnd: '' };
  const lines = ['#include <stdint.h>', '#define BMC_VALUE(x) ((x) + 0x10) \\', '  + helper(x)',
    'struct Device *dev; device_id_t id = dev->value;', 'const char *s = "continued\\', 'string"; // done'];
  const output = lines.map(line => highlightLine(line, state, 'c'));
  const has = (line, text, kind) => output[line].some(token => token.text === text && token.kind === kind);
  assert(has(0, '#include', 'preprocessor')); assert(has(0, '<stdint.h>', 'string'));
  assert(has(1, 'BMC_VALUE', 'macro')); assert(has(1, '0x10', 'number'));
  assert(has(2, 'helper', 'function')); assert.equal(state.quote, '');
  assert(has(3, 'Device', 'type')); assert(has(3, 'device_id_t', 'type')); assert(has(3, 'value', 'property'));
  assert.equal(output[5][0].kind, 'string');
  output.forEach((tokens, line) => assert.equal(tokens.map(token => token.text).join(''), lines[line]));
});

test('document checkpoints recover comments beyond the old 400-line lookback and invalidate after editing', () => {
  const { highlightDocument } = require('../src/syntax');
  let lines = ['/*', ...Array(600).fill('struct fake_call(42);'), '*/ int live = 1;'];
  const document = { version: 1, languageId: 'c', lineAt: line => ({ text: lines[line] }) };
  let tokens = highlightDocument(document, 550, 550)[0];
  assert(tokens.every(token => token.kind === 'comment'));
  assert.equal(highlightDocument(document, 601, 601)[0].find(token => token.text === 'int').kind, 'type');
  lines[0] = '// closed'; document.version++;
  tokens = highlightDocument(document, 550, 550)[0];
  assert(tokens.some(token => token.text === 'struct' && token.kind === 'keyword'));
  assert.equal(tokens.map(token => token.text).join(''), lines[550]);
});
