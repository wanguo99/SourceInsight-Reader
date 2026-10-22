'use strict';
const { highlightLine } = require('./syntax');

function parameters(document, name) {
  const state = { block: false, rawEnd: '', quote: '', directive: false, expectType: false };
  let start, depth = 0;
  for (let line = name.end.line; line < Math.min(document.lineCount, name.end.line + 128); line++) {
    let character = 0;
    for (const token of highlightLine(document.lineAt(line).text, state, document.languageId)) {
      if (!['comment', 'string'].includes(token.kind)) for (let index = 0; index < token.text.length; index++) {
        const column = character + index;
        if (line === name.end.line && column < name.end.character) continue;
        const value = token.text[index];
        if (!start) {
          if (/\s/.test(value)) continue;
          if (value !== '(') return undefined;
          start = { line, character: column };
        }
        if (value === '(') depth++;
        if (value === ')' && --depth === 0) return { start, end: { line, character: column + 1 } };
      }
      character += token.text.length;
    }
  }
}

// Symbol selection ranges identify the name; stop there instead of formatting
// the parameters or body. Reject providers that only supply a whole-body range.
function functionHeads(nodes, document) {
  const ranges = [];
  const visit = values => { for (const node of values) {
    const name = node.selectionRange, start = node.range?.start;
    if ([5, 8, 11].includes(node.kind) && name && start &&
        name.start.line === name.end.line && !/[{};\r\n]/.test(document.getText(name)) &&
        (start.line < name.end.line || start.line === name.end.line && start.character < name.end.character)) {
      ranges.push({ start, end: name.end, name: { start: name.start, end: name.end }, parameters: parameters(document, name) });
    }
    visit(node.children || []);
  } };
  visit(nodes);
  return ranges;
}

function emphasizeHeads(tokens, line, heads) {
  const ranges = heads.flatMap(head => [{ ...head, role: 'head' }, { ...head.name, role: 'name' },
    ...(head.parameters ? [{ ...head.parameters, role: 'parameters' }] : [])])
    .filter(range => range.start.line <= line && range.end.line >= line).map(range => ({
      start: range.start.line === line ? range.start.character : 0,
      end: range.end.line === line ? range.end.character : Infinity, role: range.role
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
      const roles = ranges.filter(range => range.start <= start && range.end >= stop).map(range => range.role);
      values.push({ ...token, text: token.text.slice(start - offset, stop - offset), strong: strong && !roles.includes('parameters'),
        emphasis: roles.includes('name') ? 'function-name' : roles.includes('parameters') ? 'function-parameters' : undefined });
    }
    offset = end;
  }
  return values;
}

module.exports = { functionHeads, emphasizeHeads };
