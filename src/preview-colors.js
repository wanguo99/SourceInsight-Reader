'use strict';
const theme = require('../themes/sourceinsight-reader-color-theme.json');

// Use the editor theme's semantic rules, including language/modifier specificity.
function semanticColor(type, modifiers = [], language = '', overrides = {}) {
  let color, best = -1;
  for (const rules of [theme.semanticTokenColors, overrides]) for (const [selector, value] of Object.entries(rules)) {
    const [qualified, selectedLanguage] = selector.split(':');
    const [selectedType, ...selectedModifiers] = qualified.split('.');
    if (selectedLanguage && selectedLanguage !== language || selectedType !== '*' && selectedType !== type ||
        selectedModifiers.some(modifier => !modifiers.includes(modifier))) continue;
    const foreground = typeof value === 'string' ? value : value?.foreground;
    const score = (selectedType === '*' ? 0 : 100) + selectedModifiers.length * 100 + (selectedLanguage ? 10 : 0);
    if (typeof foreground === 'string' && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(foreground) && score >= best) { color = foreground; best = score; }
  }
  return color;
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

function colorTokens(tokens, line, spans, language, overrides = {}) {
  const active = spans.filter(span => span.line === line), output = [];
  let offset = 0;
  for (const token of tokens) {
    const end = offset + token.text.length, boundaries = new Set([offset, end]);
    for (const span of active) {
      if (span.start > offset && span.start < end) boundaries.add(span.start);
      if (span.end > offset && span.end < end) boundaries.add(span.end);
    }
    const points = [...boundaries].sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index++) {
      const start = points[index], stop = points[index + 1], text = token.text.slice(start - offset, stop - offset);
      const span = active.find(span => span.start <= start && span.end >= stop);
      const names = { keyword: 'Keywords and primitive types', control: 'Control keywords', preprocessor: 'Preprocessor',
        type: 'Type references', function: 'Function names', macro: 'Function names', number: 'Numbers', string: 'Strings', comment: 'Comment' };
      const lexical = theme.tokenColors.find(rule => rule.name === (names[token.kind] || 'Default text and identifiers'))?.settings.foreground;
      output.push({ ...token, text, foreground: span ? semanticColor(span.type, span.modifiers, language, overrides) : lexical });
    }
    offset = end;
  }
  return output;
}

module.exports = { semanticColor, semanticSpans, colorTokens };
