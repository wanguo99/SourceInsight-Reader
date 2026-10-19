'use strict';
(function (root) {
  const identifier = /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u;
  const part = /[$\p{ID_Continue}]/u;
  function symbolRanges(text, symbol, limit = 20000) {
    if (!symbol || symbol.length > 256 || !identifier.test(symbol)) return [];
    const ranges = [];
    for (let offset = 0; ranges.length < limit;) {
      const start = text.indexOf(symbol, offset); if (start < 0) break;
      const end = start + symbol.length;
      const before = Array.from(text.slice(Math.max(0, start - 2), start)).pop();
      const after = Array.from(text.slice(end, end + 2))[0];
      if ((!before || !part.test(before)) && (!after || !part.test(after))) ranges.push({ start, end });
      offset = end;
    }
    return ranges;
  }
  const api = { symbolRanges, validSymbol: symbol => typeof symbol === 'string' && symbol.length <= 256 && identifier.test(symbol) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.sourceInsightSymbolMatches = api;
})(globalThis);
