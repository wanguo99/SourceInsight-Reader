'use strict';
const { uriKey } = require('../resources');
const { isExportReference } = require('./c-export-references');
const samePoint = (a, b) => a.line === b.line && a.character === b.character;
// Resolve a source role from indexed declarations, never from spelling or a
// Relation candidate. Syntax supplies declaration/parameter roles in this TU.
function boundColorSpan(index, uri, span, exports = []) {
  const point = { line: span.line, character: span.start }, values = index.definitions(uri, point);
  if (values.length !== 1) return { ...span, indexed: false, unresolved: true, modifiers: [] };
  const value = values[0], file = index.files.get(uriKey(uri));
  let type = value.category === 'macro' ? 'macro' : value.category === 'macroParameter' ? 'parameter'
    : value.category === 'label' ? 'label' : value.kind === 7 ? 'property' : value.kind === 9 ? 'enum'
      : value.kind === 21 ? 'enumMember' : value.kind === 22 ? 'struct' : value.kind === 25 ? 'type'
        : value.kind === 11 || value.id && index.functions.has(value.id) ? 'function'
          : value.kind === 12 ? span.type === 'parameter' ? 'parameter' : 'variable' : undefined;
  if (!type) return { ...span, indexed: false, unresolved: true, modifiers: [] };
  if (type === 'property' && index.memberRelations.pointer(value) && file?.calls.some(call => call.memberPosition && samePoint(call.memberPosition, point))) type = 'function';
  const sourceReference = isExportReference(exports, point, true);
  const modifiers = [...new Set([...(span.modifiers || []).filter(modifier => !sourceReference || !['declaration', 'definition'].includes(modifier)), ...(value.static ? ['static'] : [])])];
  return { ...span, type, indexed: true, unresolved: false, modifiers, ...(sourceReference ? { sourceReference: true } : {}) };
}
module.exports = { boundColorSpan };
