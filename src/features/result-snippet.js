'use strict';
function referenceSnippet(text, range, width = 500) {
  const start = Math.max(0, Math.min(text.length, range.start.character));
  const end = range.end.line === range.start.line ? Math.max(start, Math.min(text.length, range.end.character)) : text.length;
  const left = Math.max(0, start - 120), right = Math.min(text.length, start + width - 120);
  return { before: (left ? '…' : '') + text.slice(left, start), matched: text.slice(start, Math.min(end, right)),
    after: text.slice(Math.min(end, right), right) + (right < text.length ? '…' : '') };
}
module.exports = { referenceSnippet };
