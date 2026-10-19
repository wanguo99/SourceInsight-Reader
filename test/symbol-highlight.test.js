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

test('registered highlight command reads the active editor instead of a stale cached editor and reports matches', async () => {
  const env = fakeVscode(), status = [], applied = [], notices = [];
  env.api.window.setStatusBarMessage = message => { status.push(message); return { dispose() {} }; };
  env.api.window.showInformationMessage = message => { notices.push(message); };
  const { ReadingController } = loadWithVscode('../src/extension', env.api);
  const controller = new ReadingController(env.context);
  try {
    const stale = env.document('old.c', 'old');
    const current = env.document('new.c', 'new new newer');
    current.positionAt = offset => new env.api.Position(0, offset);
    const selected = new env.api.Range(0, 0, 0, 3);
    controller.session.editor = { document: stale, selection: selected };
    const editor = { document: current, selection: { ...selected, active: selected.end }, setDecorations(type, ranges) { applied.push(ranges); } };
    env.api.window.activeTextEditor = editor; env.api.window.visibleTextEditors = [editor];
    await env.api.commands.executeCommand('sourceInsightInspired.toggleSymbolHighlight');
    assert.equal(controller.symbolHighlight.symbol, 'new');
    assert.equal(controller.preview.highlightSymbol, 'new'); assert.equal(applied.at(-1).length, 2);
    assert.match(status.at(-1), /new.*2 处/);
    await env.api.commands.executeCommand('sourceInsightInspired.toggleSymbolHighlight');
    assert.equal(controller.preview.highlightSymbol, ''); assert.match(status.at(-1), /取消/);
    // Cursor-only invocation and Context / command-palette focus also work.
    editor.selection = { start: new env.api.Position(0, 5), end: new env.api.Position(0, 5), active: new env.api.Position(0, 5) };
    await env.api.commands.executeCommand('sourceInsightInspired.toggleSymbolHighlight'); assert.equal(controller.symbolHighlight.symbol, 'new');
    env.api.window.activeTextEditor = undefined; controller.session.editor = editor;
    await env.api.commands.executeCommand('sourceInsightInspired.clearSymbolHighlight');
    await controller.preview.handleMessage({ action: 'highlightSymbol', symbol: 'newer' });
    assert.equal(controller.symbolHighlight.symbol, 'newer'); assert.equal(applied.at(-1).length, 1);
    await env.api.commands.executeCommand('sourceInsightInspired.toggleSymbolHighlight', 'invalid name');
    assert.equal(notices.length, 1);
  } finally { controller.dispose(); }
});

test('pinned highlight survives workspace reload and clearing removes persisted state', async () => {
  const env = fakeVscode(), values = new Map(), changes = [], errors = [];
  const state = { get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    async update(key, value) { if (value === undefined) values.delete(key); else values.set(key, value); } };
  const { SymbolHighlight } = loadWithVscode('../src/symbol-highlight', env.api);
  let highlights = new SymbolHighlight(symbol => changes.push(symbol), state, error => errors.push(error));
  highlights.toggle('TIMEOUT_MS'); await highlights.saved; highlights.dispose();
  highlights = new SymbolHighlight(symbol => changes.push(symbol), state, error => errors.push(error));
  assert.equal(highlights.symbol, 'TIMEOUT_MS'); assert.equal(changes.at(-1), 'TIMEOUT_MS');
  highlights.toggle('first'); highlights.toggle('second'); await highlights.saved;
  assert.equal(values.get('symbolHighlight.pinnedSymbol'), 'second');
  highlights.clear(); await highlights.saved; highlights.dispose();
  highlights = new SymbolHighlight(symbol => changes.push(symbol), state, error => errors.push(error));
  assert.equal(highlights.symbol, ''); assert.equal(values.size, 0); assert.equal(errors.length, 0); highlights.dispose();
});
