'use strict';

function literalPattern(query, matchCase = false) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
}
function searchPattern(query, options = {}) {
  return options.regex ? new RegExp(query, 'gu' + (options.matchCase ? '' : 'i') + (options.multiline ? 'ms' : '')) : literalPattern(query, options.matchCase);
}
function identifierCharacter(value) { return Boolean(value && /[\p{ID_Continue}$]/u.test(value)); }
function previousCharacter(text, at) {
  if (!at) return '';
  const value = text.charCodeAt(at - 1);
  return value >= 0xdc00 && value <= 0xdfff && at > 1 ? text.slice(at - 2, at) : text[at - 1];
}
function findMatches(text, query, options = {}, limit = 20000) {
  if (!query || !options.multiline && /[\r\n]/.test(query) || limit <= 0) return [];
  const regex = searchPattern(query, options), rows = [], normalized = text.replace(/\r\n|\r/g, '\n');
  const lines = normalized.split('\n'), offsets = []; let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const position = at => {
    let low = 0, high = offsets.length;
    while (low + 1 < high) { const mid = (low + high) >>> 1; if (offsets[mid] <= at) low = mid; else high = mid; }
    return { line: low, character: at - offsets[low] };
  };
  let match;
  while ((match = regex.exec(normalized))) {
    const start = match.index, end = start + match[0].length;
    // Empty matches have no source range and can otherwise loop forever.
    if (!match[0]) { regex.lastIndex += normalized.codePointAt(regex.lastIndex) > 0xffff ? 2 : 1; continue; }
    if (!options.multiline && match[0].includes('\n')) continue;
    if (options.wholeWord && (identifierCharacter(previousCharacter(normalized, start)) ||
      identifierCharacter(end < normalized.length ? String.fromCodePoint(normalized.codePointAt(end)) : ''))) continue;
    const from = position(start), to = position(end), first = lines[from.line], last = lines[to.line];
    const left = Math.max(0, from.character - 80), right = Math.min(last.length, to.character + 180);
    rows.push({ line: from.line, start: from.character, end: to.character, endLine: to.line,
      match: match[0], lineText: first, before: (left ? '…' : '') + first.slice(left, from.character),
      matched: match[0], after: last.slice(to.character, right) + (right < last.length ? '…' : '') });
    if (rows.length >= limit) return rows;
  }
  return rows;
}

module.exports = { findMatches, literalPattern, searchPattern };
