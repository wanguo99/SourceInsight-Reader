'use strict';
const { uriKey } = require('./resources');

// Pure state and normalization helpers, independent of VS Code.
function locationKey(target) {
  const range = target.range || target.selectionRange;
  return `${uriKey(target.uri)}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function uniqueLocations(locations) {
  return [...new Map(locations.map(location => [locationKey(location), location])).values()];
}

function normalizeLocation(value) {
  return value.targetUri
    ? { uri: value.targetUri, range: value.targetSelectionRange || value.targetRange }
    : { uri: value.uri, range: value.range };
}

function normalizeSymbols(values, uri, parent) {
  return values.map(value => {
    const targetUri = value.location?.uri || uri;
    const range = value.location?.range || value.range;
    const node = {
      type: 'symbol', name: value.name, detail: value.detail || value.containerName || '',
      kind: value.kind, uri: targetUri, range,
      selectionRange: value.selectionRange || range, parent, children: []
    };
    node.children = normalizeSymbols(value.children || [], targetUri, node);
    return node;
  });
}

const functionKinds = new Set([5, 8, 11]); // Method, Constructor, Function
function filterSymbols(nodes, query = '', sort = 'position', parent, includeAll = false) {
  const filtered = [];
  for (const node of nodes) {
    const copy = { ...node, parent, children: [] };
    const children = filterSymbols(node.children, query, sort, copy, includeAll);
    if (((includeAll || functionKinds.has(node.kind)) && node.name.toLowerCase().includes(query.toLowerCase())) || children.length) {
      copy.children = children;
      filtered.push(copy);
    }
  }
  return filtered.sort(sort === 'name'
    ? (a, b) => a.name.localeCompare(b.name) || comparePosition(a.range.start, b.range.start)
    : (a, b) => comparePosition(a.range.start, b.range.start));
}

function comparePosition(a, b) { return a.line - b.line || a.character - b.character; }
function contains(range, position) {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) < 0;
}
function enclosingFunction(nodes, position) {
  let best;
  for (const node of nodes) {
    if (!contains(node.range, position)) continue;
    const nested = enclosingFunction(node.children, position);
    if (nested) best = nested;
    else if (functionKinds.has(node.kind)) best = node;
  }
  return best;
}

function normalizeCalls(root, calls, direction, ancestors = []) {
  return calls.map(call => {
    const item = direction === 'incoming' ? call.from : call.to;
    const callerUri = direction === 'incoming' ? item.uri : root.uri;
    const id = locationKey({ uri: item.uri, range: item.selectionRange });
    return {
      type: 'relation', item, uri: item.uri, range: item.selectionRange,
      name: item.name, ancestors: [...ancestors, id], cycle: ancestors.includes(id),
      sites: uniqueLocations(call.fromRanges.map(range => ({ uri: callerUri, range })))
    };
  });
}

class RequestGate {
  constructor() { this.version = 0; this.disposed = false; }
  next() { return ++this.version; }
  current(version) { return !this.disposed && version === this.version; }
  invalidate() { this.version++; }
  dispose() { this.disposed = true; this.invalidate(); }
}

class NavigationHistory {
  constructor(limit = 100) { this.entries = []; this.index = -1; this.limit = limit; }
  push(target) {
    if (this.index >= 0 && locationKey(this.entries[this.index]) === locationKey(target)) return;
    this.entries.splice(this.index + 1);
    this.entries.push(target);
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
  }
  back() { return this.index > 0 ? this.entries[--this.index] : undefined; }
  forward() { return this.index < this.entries.length - 1 ? this.entries[++this.index] : undefined; }
}

// Supported glob subset: *, ?, **. Unlike shell globs these work on URI paths.
function globRegex(pattern) {
  let result = '^';
  pattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; result += '(?:.*/)?'; }
      else result += '.*';
    } else if (char === '*') result += '[^/]*';
    else if (char === '?') result += '[^/]';
    else result += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(result + '$');
}

module.exports = {
  locationKey, uniqueLocations, normalizeLocation, normalizeSymbols, filterSymbols,
  contains, enclosingFunction, normalizeCalls, RequestGate, NavigationHistory, globRegex
};
