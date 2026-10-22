'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TextmateEngine } = require('../src/infrastructure/textmate-engine');
const { textmateTheme } = require('../src/editor-color-settings');
const { colorTokens } = require('../src/preview-colors');
const { highlightLine } = require('../src/syntax');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-colors-'));
  const file = path.join(directory, 'test.tmLanguage.json');
  await fs.writeFile(file, JSON.stringify({ scopeName: 'source.test', patterns: [
    { begin: '/\\*', end: '\\*/', name: 'comment.block' },
    { match: '(#define)\\s+(\\w+)', captures: { 1: { name: 'keyword.control.directive' }, 2: { name: 'entity.name.function.preprocessor' } } },
    { match: '\\bint\\b', name: 'storage.type' }, { match: '\\breturn\\b', name: 'keyword.control' },
    { match: '[{}();]', name: 'punctuation' }, { match: '[=+]', name: 'keyword.operator' }, { match: '\\b[0-9]+\\b', name: 'constant.numeric' }
  ] }));
  const engine = new TextmateEngine();
  t.after(async () => { engine.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return { engine, message: { uri: 'file:///test.c', language: 'c', grammars: [{ language: 'c', scopeName: 'source.test', path: file }],
    theme: textmateTheme(), text: '#define MAX 4\n/* comment\nstill a comment */\nint run() { return MAX + 1; }', start: 0, end: 3 } };
}

test('Context uses TextMate scopes for macro definitions, punctuation, operators and multiline comments', async t => {
  const { engine, message } = await fixture(t);
  const spans = await engine.colorize(message);
  const at = (line, start) => spans.find(span => span.line === line && span.start <= start && span.end > start)?.foreground.toLowerCase();
  assert.equal(at(0, 8), '#000080');
  assert.equal(at(2, 0), '#800080');
  assert.equal(at(3, 0), '#008000');
  assert.equal(at(3, message.text.split('\n')[3].indexOf('+')), '#008000');
  assert.equal(at(3, message.text.split('\n')[3].indexOf(';')), '#800080');
  const excerpt = await engine.colorize({ ...message, start: 2, end: 2 });
  assert.equal(excerpt[0].foreground.toLowerCase(), '#800080');
});

test('TextMate customization changes previews and semantic classifications override only their own ranges', async t => {
  const { engine, message } = await fixture(t);
  const theme = textmateTheme({ '[SourceInsight*]': { comments: '#224466' } });
  const lexical = await engine.colorize({ ...message, theme });
  assert.equal(lexical.find(span => span.line === 2).foreground.toLowerCase(), '#224466');
  const source = message.text.split('\n')[3], start = source.indexOf('MAX');
  const tokens = colorTokens(highlightLine(source), 3, [{ line: 3, start, end: start + 3, type: 'macro', modifiers: [] }], 'c', {}, lexical);
  assert.equal(tokens.map(token => token.text).join(''), source);
  assert.equal(tokens.find(token => token.text === 'MAX').foreground, '#c00000');
  assert(tokens.some(token => token.foreground.toLowerCase() === '#800080' && token.text.includes(';')));
  assert.deepEqual(await engine.colorize(message, () => true), []);
});

test('tokenization checkpoint state is invalidated after unsaved document edits', async t => {
  const { engine, message } = await fixture(t);
  const text = '/*\n' + Array.from({ length: 130 }, () => 'int still_comment;').join('\n');
  let spans = await engine.colorize({ ...message, text, start: 120, end: 121 });
  assert(spans.every(span => span.foreground.toLowerCase() === '#800080'));
  spans = await engine.colorize({ ...message, text: text.replace('/*', '  '), start: 120, end: 121 });
  assert(spans.some(span => span.foreground.toLowerCase() === '#008000'));
});
