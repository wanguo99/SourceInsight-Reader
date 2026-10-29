'use strict';
const { withoutTrivia, withoutDirectives } = require('./c-source-projection');
const { sameUri } = require('../resources');

// These macros export an existing C symbol. Unlike SYSCALL_DEFINE or other
// declaration macros, their expansions must not create source definitions.
const exportsPattern = /\b(EXPORT_SYMBOL(?:_GPL|_NS|_NS_GPL|_GPL_FUTURE|_FOR_MODULES)?|EXPORT_PER_CPU_SYMBOL(?:_GPL)?)\s*\(/g;
function exportReferences(source) {
  if (!/\bEXPORT_(?:SYMBOL|PER_CPU_SYMBOL)/.test(source)) return [];
  const code = withoutDirectives(withoutTrivia(source), source), found = [];
  for (const match of code.matchAll(exportsPattern)) {
    let before = match.index - 1;
    while (before >= 0 && /\s/.test(code[before])) before--;
    // Do not mistake a real function declaration/definition with this name
    // for a macro invocation. Export statements start at a statement boundary.
    if (before >= 0 && !';{}'.includes(code[before])) continue;
    const open = match.index + match[0].length - 1;
    const argument = /^\s*([A-Za-z_$][\w$]*)\s*(?=[,)])/.exec(code.slice(open + 1));
    if (!argument) continue;
    let end = open + 1, depth = 1;
    for (; end < code.length && depth; end++) { if (code[end] === '(') depth++; else if (code[end] === ')') depth--; }
    if (depth) continue;
    const begin = open + 1 + argument[0].indexOf(argument[1]);
    found.push({ name: match[1], start: match.index, end, target: argument[1], targetStart: begin, targetEnd: begin + argument[1].length });
  }
  if (!found.length) return [];
  const starts = [0]; for (let at = 0; at < source.length; at++) if (source[at] === '\n') starts.push(at + 1);
  const point = at => { let lo = 0, hi = starts.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= at) lo = mid + 1; else hi = mid; } return { line: lo - 1, character: at - starts[lo - 1] }; };
  return found.map(value => ({ name: value.name, target: value.target, range: { start: point(value.start), end: point(value.end) },
    targetRange: { start: point(value.targetStart), end: point(value.targetEnd) } }));
}
function isExportReference(references, point, argumentOnly = false) {
  if (!point) return false;
  const compare = (a, b) => a.line - b.line || a.character - b.character;
  return references.some(value => { const range = argumentOnly ? value.targetRange : value.range; return compare(range.start, point) <= 0 && compare(point, range.end) < 0; });
}
function filterExportSymbols(nodes, references, uri, parent) {
  if (!references.length) return nodes;
  const result = [];
  for (const node of nodes) {
    const target = node.location?.uri || node.uri || uri, point = node.selectionRange?.start || node.location?.range?.start || node.range?.start;
    const hidden = sameUri(target, uri) && isExportReference(references, point);
    const copy = { ...node };
    if ('parent' in node) copy.parent = parent;
    const children = filterExportSymbols(node.children || [], references, uri, hidden ? parent : copy);
    if (hidden) result.push(...children);
    else { copy.children = children; result.push(copy); }
  }
  return result;
}
function correctExportTokens(spans, references) {
  if (!references.length) return spans;
  return spans.map(span => {
    if (!references.some(value => value.targetRange.start.line === span.line && value.targetRange.start.character === span.start &&
        value.targetRange.end.line === span.line && value.targetRange.end.character === span.end)) return span;
    return { ...span, sourceReference: true, modifiers: (span.modifiers || []).filter(value => value !== 'declaration' && value !== 'definition') };
  });
}
module.exports = { exportReferences, isExportReference, filterExportSymbols, correctExportTokens };
