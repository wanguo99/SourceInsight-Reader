'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const theme = require('../themes/sourceinsight-reader-color-theme.json');
const { semanticColor, semanticSpans, colorTokens } = require('../src/preview-colors');
const { highlightLine } = require('../src/syntax');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('Context uses the native theme colors and semantic modifier precedence', () => {
  for (const type of ['function', 'variable', 'parameter', 'property', 'enumMember']) {
    const rule = theme.semanticTokenColors[type];
    assert.equal(semanticColor(type), typeof rule === 'string' ? rule : rule.foreground);
  }
  assert.equal(semanticColor('function', ['definition']), theme.semanticTokenColors['*.definition'].foreground);
  assert.equal(semanticColor('variable', ['static', 'definition']), theme.semanticTokenColors['variable.static'].foreground);
  assert.equal(semanticColor('variable', [], 'c', { 'variable:c': '#123456' }), '#123456');
  assert.equal(semanticColor('variable', [], 'cpp', { 'variable:c': '#123456' }), theme.semanticTokenColors.variable);
});

test('semantic color and font styles resolve independently, including explicit disabling', () => {
  const { semanticStyle } = require('../src/preview-colors');
  const style = semanticStyle('macro', ['definition'], 'c', { 'macro.definition:c': { bold: false, italic: true, underline: true } });
  assert.equal(style.foreground, '#c00000');
  assert.equal(style.bold, false); assert.equal(style.italic, true); assert.equal(style.underline, true);
});

test('semantic token deltas preserve UTF-16 positions and apply variable and field colors without modifying source', () => {
  const legend = { tokenTypes: ['variable', 'property'], tokenModifiers: ['static'] };
  const spans = semanticSpans(legend, new Uint32Array([0, 3, 3, 0, 1, 0, 5, 5, 1, 0, 1, 0, 3, 0, 0]));
  assert.deepEqual(spans.map(span => [span.line, span.start, span.type]), [[0, 3, 'variable'], [0, 8, 'property'], [1, 0, 'variable']]);
  const text = '😀 obj->field';
  const tokens = colorTokens(highlightLine(text), 0, spans, 'c');
  assert.equal(tokens.map(token => token.text).join(''), text);
  assert.equal(tokens.find(token => token.text === 'obj').foreground, theme.semanticTokenColors['variable.static'].foreground);
  assert.equal(tokens.find(token => token.text === 'field').foreground, theme.semanticTokenColors.property);
  assert.deepEqual(semanticSpans(legend, [1, 2]), []);
});

test('lexical fallback also takes its palette from the editor theme', () => {
  const tokens = colorTokens(highlightLine('if (obj) return obj->field;'), 0, [], 'c');
  assert.equal(tokens.find(token => token.text === 'if').foreground,
    theme.tokenColors.find(rule => rule.name === 'Control keywords').settings.foreground);
  assert.equal(tokens.find(token => token.text === 'obj').foreground,
    theme.tokenColors.find(rule => rule.name === 'Default text and identifiers').settings.foreground);
});

test('Context respects disabled editor semantic highlighting without querying its provider', async () => {
  const env = fakeVscode(), document = env.document('colors.c');
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  let queries = 0;
  env.commands.set('vscode.provideDocumentSemanticTokens', async () => { queries++; return { data: new Uint32Array() }; });
  env.settings.set('editor.semanticHighlighting.enabled', false);
  assert.deepEqual(await new LanguageAdapter().semanticTokens(document.uri), []);
  assert.equal(queries, 0);
});

test('a delayed semantic color response cannot recolor a newer Context preview', async () => {
  const env = fakeVscode(), first = env.document('first.c', 'first'), second = env.document('second.c', 'second');
  const { ContextView } = loadWithVscode('../src/context', env.api);
  let resolve;
  const old = new Promise(done => { resolve = done; });
  const view = new ContextView({ semanticTokens: async uri => uri.toString() === first.uri.toString() ? old : [] }, () => {});
  try {
    await view.show({ uri: first.uri, range: new env.api.Range(0, 0, 0, 5) });
    await view.show({ uri: second.uri, range: new env.api.Range(0, 0, 0, 6) });
    resolve([{ line: 0, start: 0, end: 5, type: 'enumMember', modifiers: [] }]);
    await new Promise(done => setImmediate(done));
    assert.equal(view.state.lines[0].text, 'second');
    assert.equal(view.state.lines[0].tokens[0].foreground, '#000000');
  } finally { view.dispose(); }
});

test('locking a loaded preview cancels navigation while allowing its pending semantic styling to finish', async () => {
  const env = fakeVscode(), document = env.document('locked.c', '#define FLAG 1');
  const { ContextView } = loadWithVscode('../src/context', env.api);
  let resolve;
  const colors = new Promise(done => { resolve = done; });
  const view = new ContextView({ semanticTokens: () => colors }, () => {});
  try {
    await view.show({ uri: document.uri, range: new env.api.Range(0, 8, 0, 12) });
    view.toggleLock();
    resolve([{ line: 0, start: 8, end: 12, type: 'macro', modifiers: ['declaration'] }]);
    await new Promise(done => setImmediate(done));
    assert.equal(view.locked, true);
    assert.equal(view.state.lines[0].tokens.find(token => token.text === 'FLAG').foreground, '#c00000');
  } finally { view.dispose(); }
});


test('macro definitions, declarations and uses share red while enum definitions retain their own color', () => {
  const { semanticColor } = require('../src/preview-colors');
  for (const modifiers of [[], ['declaration'], ['definition']]) {
    assert.equal(semanticColor('macro', modifiers, 'c'), '#c00000');
  }
  assert.equal(semanticColor('enumMember', ['definition'], 'c'), '#000080');
});
