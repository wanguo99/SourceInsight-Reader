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
