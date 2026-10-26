'use strict';
const { preprocessorSymbols } = require('../document-symbols');
const cache = new WeakMap();
const cLanguages = new Set(['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp']);
const range = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } });

function literalIncludes(document) {
  if (!cLanguages.has(document.languageId)) return [];
  const previous = cache.get(document);
  if (previous?.version === document.version) return previous.includes;
  const includes = preprocessorSymbols(document.getText(), document.uri, range, true)
    .filter(node => /^(?:"[^"\r\n]+"|<[^>\r\n]+>)$/.test(node.detail))
    .map(node => ({ name: node.detail.slice(1, -1), quoted: node.detail.startsWith('"'), range: node.selectionRange }));
  cache.set(document, { version: document.version, includes }); return includes;
}

function literalIncludeAt(document, point) {
  if (!document || !Number.isInteger(point?.line) || !Number.isInteger(point.character) || point.line < 0 || point.line >= document.lineCount) return;
  // Ordinary symbols do not need a full preprocessor scan on every edit.
  const previous = cache.get(document);
  if (previous?.version !== document.version && !/[#"<>\\]/.test(document.lineAt(point.line).text)) return;
  const compare = (a, b) => a.line - b.line || a.character - b.character;
  return literalIncludes(document).find(include => compare(include.range.start, point) <= 0 && compare(point, include.range.end) < 0);
}

module.exports = { literalIncludes, literalIncludeAt };
