'use strict';

// Symbol selection ranges identify the name; stop there instead of formatting
// the parameters or body. Reject providers that only supply a whole-body range.
function functionHeads(nodes, document) {
  const ranges = [];
  const visit = values => { for (const node of values) {
    const name = node.selectionRange, start = node.range?.start;
    if ([5, 8, 11].includes(node.kind) && name && start &&
        name.start.line === name.end.line && !/[{};\r\n]/.test(document.getText(name)) &&
        (start.line < name.end.line || start.line === name.end.line && start.character < name.end.character)) {
      ranges.push({ start, end: name.end });
    }
    visit(node.children || []);
  } };
  visit(nodes);
  return ranges;
}

function emphasizeHeads(tokens, line, heads) {
  const ranges = heads.filter(head => head.start.line <= line && head.end.line >= line).map(head => ({
    start: head.start.line === line ? head.start.character : 0,
    end: head.end.line === line ? head.end.character : Infinity
  }));
  if (!ranges.length) return tokens;
  const values = []; let offset = 0;
  for (const token of tokens) {
    const end = offset + token.text.length, boundaries = new Set([offset, end]);
    for (const range of ranges) {
      if (range.start > offset && range.start < end) boundaries.add(range.start);
      if (range.end > offset && range.end < end) boundaries.add(range.end);
    }
    const points = [...boundaries].sort((a, b) => a - b);
    for (let index = 0; index < points.length - 1; index++) {
      const start = points[index], stop = points[index + 1];
      const strong = token.kind !== 'comment' && ranges.some(range => range.start <= start && range.end >= stop);
      values.push({ ...token, text: token.text.slice(start - offset, stop - offset), strong });
    }
    offset = end;
  }
  return values;
}

module.exports = { functionHeads, emphasizeHeads };
