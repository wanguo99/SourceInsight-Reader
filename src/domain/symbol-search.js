'use strict';
// Match identifier fragments, not arbitrary scattered letters. Fragment order is
// irrelevant; concatenated prefixes also support CreateWindow -> CreWin.
function fragments(value) {
  return value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(part => part.toLowerCase());
}
function symbolScore(name, query) {
  const needle = query.trim().toLowerCase(), lower = name.toLowerCase();
  if (!needle) return 0;
  if (lower === needle) return 10000;
  if (lower.startsWith(needle)) return 8000 - name.length;
  if (lower.includes(needle)) return 6000 - lower.indexOf(needle) - name.length;
  const parts = fragments(name), wanted = fragments(query);
  if (!wanted.length) return -1;
  // Bipartite assignment keeps repeated prefixes correct without exponential
  // backtracking when searching generated identifiers with many fragments.
  const assigned = new Map();
  const assign = (at, seen) => parts.some((part, index) => {
    if (seen.has(index) || !part.startsWith(wanted[at])) return false;
    seen.add(index);
    if (!assigned.has(index) || assign(assigned.get(index), seen)) { assigned.set(index, at); return true; }
    return false;
  });
  if (wanted.length > 1) return wanted.every((_, index) => assign(index, new Set())) ? 4000 - name.length : -1;
  const memo = new Map();
  const join = (at, offset) => {
    if (offset === needle.length) return true;
    const key = `${at}:${offset}`;
    if (memo.has(key)) return memo.get(key);
    const result = parts.some((part, index) => {
      if (index < at) return false;
      for (let size = 1; size <= part.length && offset + size <= needle.length; size++) {
        if (!needle.startsWith(part.slice(0, size), offset)) break;
        if (join(index + 1, offset + size)) return true;
      }
      return false;
    });
    memo.set(key, result); return result;
  };
  return join(0, 0) ? 2000 - name.length : -1;
}
function rankSymbols(values, query, limit = 1000) {
  return values.map(value => ({ value, score: symbolScore(value.name, query) })).filter(row => row.score >= 0)
    .sort((a, b) => b.score - a.score || a.value.name.localeCompare(b.value.name))
    .slice(0, limit).map(row => row.value);
}
module.exports = { fragments, symbolScore, rankSymbols };
