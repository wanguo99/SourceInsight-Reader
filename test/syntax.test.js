'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { highlightLine } = require('../src/syntax');

test('Python previews handle comments, floor division, prefixed strings and multiline docstrings', () => {
  const state = { block: false, rawEnd: '' };
  const lines = ['def leaf(value: int): # comment', '    return value // 2', 'text = f"value={value}"', 'doc = r"""first', '/* still a string */', 'last"""; leaf(2)'];
  const output = lines.map(line => highlightLine(line, state, 'python'));
  output.forEach((tokens, i) => assert.equal(tokens.map(t => t.text).join(''), lines[i]));
  assert(output[0].some(t => t.text === 'def' && t.kind === 'keyword'));
  assert(output[0].some(t => t.kind === 'comment'));
  assert(!output[1].some(t => t.kind === 'comment'));
  assert(output[2].some(t => t.text === 'f"value={value}"' && t.kind === 'string'));
  assert(output[4].every(t => t.kind === 'string'));
  assert(output[5].some(t => t.text === 'leaf' && t.kind === 'function'));
});

test('Java previews handle declarations, comments and multiline text blocks', () => {
  const state = { block: false, rawEnd: '' };
  const lines = ['public class Main {', '  private boolean ready = true; // flag', '  String text = """', '  # not a comment', '  """; leaf(42);'];
  const output = lines.map(line => highlightLine(line, state, 'java'));
  output.forEach((tokens, i) => assert.equal(tokens.map(t => t.text).join(''), lines[i]));
  assert(output[0].some(t => t.text === 'public' && t.kind === 'keyword'));
  assert(output[0].some(t => t.text === 'Main' && t.kind === 'type'));
  assert(output[1].some(t => t.text === 'boolean' && t.kind === 'type'));
  assert(output[3].every(t => t.kind === 'string'));
  assert(output[4].some(t => t.text === 'leaf' && t.kind === 'function'));
});

test('multiline Java and Python previews preserve escaped delimiters and cached state', () => {
  const { highlightDocument } = require('../src/syntax');
  for (const languageId of ['java', 'python']) {
    const lines = ['text = """', ...Array(140).fill('escaped \\""" delimiter'), 'end"""; leaf(2)'];
    const document = { version: 1, languageId, lineAt: line => ({ text: lines[line] }) };
    assert(highlightDocument(document, 139, 139)[0].every(t => t.kind === 'string'));
    assert(highlightDocument(document, 141, 141)[0].some(t => t.text === 'leaf' && t.kind === 'function'));
  }
});

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
  assert.deepEqual(highlightLine(source, undefined, 'ruby'), [{ text: source, kind: 'plain' }]);
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
