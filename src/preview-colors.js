'use strict';
const theme = require('../themes/sourceinsight-reader-color-theme.json');

// Use the editor theme's semantic rules, including language/modifier specificity.
function semanticStyle(type, modifiers = [], language = '', overrides = {}) {
  const result = {}, best = {};
  for (const rules of [theme.semanticTokenColors, ...(Array.isArray(overrides) ? overrides : [overrides])]) for (const [selector, value] of Object.entries(rules)) {
    const [qualified, selectedLanguage] = selector.split(':');
    const [selectedType, ...selectedModifiers] = qualified.split('.');
    if (selectedLanguage && selectedLanguage !== language || selectedType !== '*' && selectedType !== type ||
        selectedModifiers.some(modifier => !modifiers.includes(modifier))) continue;
    const score = (selectedType === '*' ? 0 : 100) + selectedModifiers.length * 100 + (selectedLanguage ? 10 : 0);
    const style = typeof value === 'string' ? { foreground: value } : value || {};
    for (const key of ['foreground', 'bold', 'italic', 'underline', 'strikethrough']) {
      const valid = key === 'foreground' ? typeof style[key] === 'string' && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(style[key]) : typeof style[key] === 'boolean';
      if (valid && score >= (best[key] ?? -1)) { result[key] = style[key]; best[key] = score; }
    }
  }
  return result;
}
function semanticColor(type, modifiers = [], language = '', overrides = {}) {
  return semanticStyle(type, modifiers, language, overrides).foreground;
}

function semanticSpans(legend, data) {
  if (!legend?.tokenTypes || !data || data.length % 5) return [];
  const spans = []; let line = 0, character = 0;
  for (let index = 0; index < data.length; index += 5) {
    line += data[index]; character = data[index] ? data[index + 1] : character + data[index + 1];
    const type = legend.tokenTypes[data[index + 3]];
    if (!type || !data[index + 2]) continue;
    spans.push({ line, start: character, end: character + data[index + 2], type,
      modifiers: (legend.tokenModifiers || []).filter((_, bit) => data[index + 4] & (1 << bit)) });
  }
  return spans;
}

function colorTokens(tokens, line, spans, language, overrides = {}, lexicalSpans = []) {
  const active = spans.filter(span => span.line === line), lexicalActive = lexicalSpans.filter(span => span.line === line), output = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.text.length, boundaries = new Set([offset, end]);
    for (const span of [...active, ...lexicalActive]) {
      if (span.start > offset && span.start < end) boundaries.add(span.start);
      if (span.end > offset && span.end < end) boundaries.add(span.end);
    }
    const points = [...boundaries].sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index++) {
      const start = points[index], stop = points[index + 1], text = token.text.slice(start - offset, stop - offset);
      const span = active.find(span => span.start <= start && span.end >= stop);
      const names = { keyword: 'Keywords and primitive types', control: 'Control keywords', preprocessor: 'Preprocessor',
        type: 'Type references', function: 'Function names', macro: 'Constants', number: 'Numbers', string: 'Strings', comment: 'Comment' };
      const lexical = theme.tokenColors.find(rule => rule.name === (names[token.kind] || 'Default text and identifiers'))?.settings.foreground;
      const grammarStyle = lexicalActive.find(span => span.start <= start && span.end >= stop);
      const style = span?.unresolved ? { foreground: theme.colors['editor.foreground'], bold: false, italic: false, underline: false, strikethrough: false }
        : { ...grammarStyle, ...(span ? semanticStyle(span.type, span.modifiers, language, overrides) : {}) };
      output.push({ ...token, text, foreground: style.foreground || lexical,
        defaultText: span?.unresolved || !span && token.kind === 'plain' && (grammarStyle?.defaultText || /^#000000$/i.test(style.foreground || lexical || '')),
        bold: style.bold, italic: style.italic, underline: style.underline, strikethrough: style.strikethrough });
    }
    offset = end;
  }
  return output;
}

module.exports = { semanticStyle, semanticColor, semanticSpans, colorTokens };
