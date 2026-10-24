'use strict';

function literalPattern(query, matchCase = false) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
}
function identifierCharacter(value) { return Boolean(value && /[\p{ID_Continue}$]/u.test(value)); }
function previousCharacter(text, at) {
  if (!at) return '';
  const value = text.charCodeAt(at - 1);
  return value >= 0xdc00 && value <= 0xdfff && at > 1 ? text.slice(at - 2, at) : text[at - 1];
}
function findMatches(text, query, options = {}, limit = 20000) {
  if (!query || /[\r\n]/.test(query)) return [];
  const regex = literalPattern(query, options.matchCase), rows = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (let line = 0; line < lines.length; line++) {
    regex.lastIndex = 0; let match;
    while ((match = regex.exec(lines[line]))) {
      const start = match.index, end = start + match[0].length;
      if (options.wholeWord && (identifierCharacter(previousCharacter(lines[line], start)) ||
        identifierCharacter(end < lines[line].length ? String.fromCodePoint(lines[line].codePointAt(end)) : ''))) continue;
      const from = Math.max(0, start - 80), to = Math.min(lines[line].length, Math.max(from + 260, end));
      rows.push({ line, start, end, match: match[0], lineText: lines[line],
        before: (from ? '…' : '') + lines[line].slice(from, start), matched: match[0],
        after: lines[line].slice(end, to) + (to < lines[line].length ? '…' : '') });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

module.exports = { findMatches, literalPattern };
