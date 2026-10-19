'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { symbolRanges, validSymbol } = require('../media/symbol-matches');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('fixed symbol matching uses exact Unicode identifier boundaries and UTF-16 positions', () => {
  const text = '😀foo foo_bar Foo $foo foo$ /* foo */ "foo" foo';
  const ranges = symbolRanges(text, 'foo');
  assert.deepEqual(ranges.map(range => text.slice(range.start, range.end)), ['foo', 'foo', 'foo', 'foo']);
  assert.equal(ranges[0].start, 2);
  assert.equal(symbolRanges('变量 变量名 变量', '变量').length, 2);
  assert.equal(symbolRanges('𐐀foo foo𐐀 foo', 'foo').length, 1);
  assert.equal(symbolRanges('foo foo', 'foo', 1).length, 1);
  for (const value of ['', 'a b', 'a\nb', '3x', '.*']) assert.equal(validSymbol(value), false);
});

test('fixed highlighting follows visible editors, edits, cancellation and disposal', () => {
  const env = fakeVscode(), visible = new env.api.EventEmitter(), applied = [], changes = [];
  env.api.window.onDidChangeVisibleTextEditors = visible.event;
  const document = env.document('a.c', 'foo food foo');
  document.positionAt = offset => new env.api.Position(0, offset);
  const editor = { document, setDecorations(type, ranges) { applied.push(ranges); } };
  env.api.window.visibleTextEditors = [editor];
  const { SymbolHighlight } = loadWithVscode('../src/symbol-highlight', env.api);
  const highlights = new SymbolHighlight(symbol => changes.push(symbol));
  highlights.toggle('foo'); assert.equal(applied.at(-1).length, 2);
  assert.equal(applied.at(-1)[1].start.character, 9);
  document.text = 'foo'; visible.fire([editor]); assert.equal(applied.at(-1).length, 1);
  assert.equal(highlights.toggle('not a name'), false); assert.equal(highlights.symbol, 'foo');
  highlights.toggle('foo'); assert.equal(applied.at(-1).length, 0);
  highlights.toggle('food'); highlights.clear(); assert.equal(applied.at(-1).length, 0);
  assert.deepEqual(changes, ['foo', '', 'food', '']); highlights.dispose();
});
