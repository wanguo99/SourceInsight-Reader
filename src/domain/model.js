'use strict';
const { uriKey } = require('../resources');
/** @param {{line:number, character:number}} value @returns {import('./contracts').Position} */
function position(value) { return Object.freeze({ line: value.line, character: value.character }); }
/** @param {import('./contracts').Range} value @returns {import('./contracts').Range} */
function range(value) { return Object.freeze({ start: position(value.start), end: position(value.end) }); }
/** @param {{uri: string | {toString():string}, range: import('./contracts').Range, documentVersion?:number}} value @returns {import('./contracts').SourceLocation} */
function location(value) { return Object.freeze({ uri: value.uri.toString(), range: range(value.range), ...(value.documentVersion === undefined ? {} : { documentVersion: value.documentVersion }) }); }
/** @param {{name:string, kind?:number, uri:string | {toString():string}, selectionRange:import('./contracts').Range, range?:import('./contracts').Range, detail?:string}} item @param {boolean} unresolved @returns {import('./contracts').Symbol} */
function symbol(item, unresolved = false) {
  const target = location({ uri: item.uri, range: item.selectionRange });
  return Object.freeze({ id: `${uriKey(item.uri)}:${item.name}:${target.range.start.line}:${target.range.start.character}`, name: item.name,
    kind: item.kind ?? 11, location: target, extent: range(item.range || item.selectionRange), detail: item.detail || '', unresolved });
}
/** @template T @param {readonly T[]} data @param {import('./contracts').ProviderId} provider @param {import('./contracts').QueryStatus} status @param {string} revision @param {readonly string[]} diagnostics @returns {import('./contracts').QueryResult<T>} */
function queryResult(data, provider, status, revision = '', diagnostics = []) {
  return Object.freeze({ data: Object.freeze([...data]), provider, status, revision, diagnostics: Object.freeze([...diagnostics]) });
}
module.exports = { position, range, location, symbol, queryResult };
