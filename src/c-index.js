'use strict';
const path = require('node:path');
const { uriKey } = require('./resources');

function inside(range, point) {
  const cmp = (a, b) => a.line - b.line || a.character - b.character;
  return cmp(range.start, point) <= 0 && cmp(point, range.end) < 0;
}
function key(value) { return uriKey({ toString: () => value }); }
function fileKey(file) { return process.platform === 'win32' ? file.toLowerCase() : file; }

class CIndex {
  constructor() { this.files = new Map(); this.generation = 0; this.rebuild(); }
  replace(files) { this.files = new Map(files.map(file => [key(file.uri), file])); this.rebuild(); }
  update(file) {
    const uri = key(file.uri), old = this.files.get(uri);
    if (!old || old.path !== file.path) { this.files.set(uri, file); this.rebuild(); return; }
    const affected = new Set([uri]);
    const names = new Set([...old.functions, ...file.functions].map(fn => fn.name));
    for (const name of names) for (const caller of this.callersByName.get(name) || []) affected.add(caller);
    for (const candidate of this.files.keys()) if (this.visible(candidate).has(uri)) affected.add(candidate);
    for (const fn of old.functions) {
      this.functions.delete(fn.id);
      const remaining = (this.names.get(fn.name) || []).filter(value => value.id !== fn.id);
      if (remaining.length) this.names.set(fn.name, remaining); else this.names.delete(fn.name);
    }
    for (const name of new Set(old.calls.map(call => call.name))) this.callersByName.get(name)?.delete(uri);
    this.files.set(uri, file); this.closures.clear();
    for (const fn of file.functions) {
      this.functions.set(fn.id, fn); const values = this.names.get(fn.name) || []; values.push(fn); this.names.set(fn.name, values);
    }
    for (const call of file.calls) {
      if (!this.callersByName.has(call.name)) this.callersByName.set(call.name, new Set());
      this.callersByName.get(call.name).add(uri);
    }
    for (const candidate of this.files.keys()) if (this.visible(candidate).has(uri)) affected.add(candidate);
    for (const name of names) for (const caller of this.callersByName.get(name) || []) affected.add(caller);
    for (const candidate of affected) {
      const previous = new Set(this.edgesByFile.get(candidate) || []);
      for (const edge of previous) {
        const out = this.outgoing.get(edge.caller)?.filter(value => !previous.has(value)) || [];
        if (out.length) this.outgoing.set(edge.caller, out); else this.outgoing.delete(edge.caller);
        for (const target of edge.targets) {
          const incoming = this.incoming.get(target)?.filter(value => !previous.has(value)) || [];
          if (incoming.length) this.incoming.set(target, incoming); else this.incoming.delete(target);
        }
      }
      this.edgesByFile.delete(candidate);
    }
    for (const candidate of affected) this.buildEdges(this.files.get(candidate));
    this.generation++;
  }
  remove(uri) { this.files.delete(key(uri)); this.rebuild(); }
  rebuild() {
    this.generation++; this.functions = new Map(); this.names = new Map();
    this.paths = new Map(); this.suffixes = new Map(); this.closures = new Map();
    this.incoming = new Map(); this.outgoing = new Map(); this.edgesByFile = new Map(); this.callersByName = new Map();
    for (const file of this.files.values()) {
      this.paths.set(fileKey(path.normalize(file.path)), key(file.uri));
      const parts = file.path.replace(/\\/g, '/').split('/');
      for (let i = 0; i < parts.length; i++) {
        const suffix = fileKey(parts.slice(i).join('/'));
        if (!this.suffixes.has(suffix)) this.suffixes.set(suffix, []);
        this.suffixes.get(suffix).push(key(file.uri));
      }
      for (const fn of file.functions) {
        this.functions.set(fn.id, fn);
        if (!this.names.has(fn.name)) this.names.set(fn.name, []);
        this.names.get(fn.name).push(fn);
      }
    }
    for (const file of this.files.values()) this.buildEdges(file);
  }
  buildEdges(file) {
    if (!file) return;
      const fileUri = key(file.uri), edges = [];
      for (const call of file.calls) {
        if (!this.callersByName.has(call.name)) this.callersByName.set(call.name, new Set());
        this.callersByName.get(call.name).add(fileUri);
        if (call.indirect) continue;
        const candidates = this.resolve(file.uri, call.name);
        const resolved = candidates.length === 1;
        const edge = { ...call, file: file.uri, targets: candidates.map(fn => fn.id), resolved }; edges.push(edge);
        if (!this.outgoing.has(call.caller)) this.outgoing.set(call.caller, []);
        this.outgoing.get(call.caller).push(edge);
        // Ambiguous edges are never presented as confirmed incoming calls.
        if (resolved) {
          const target = candidates[0].id;
          if (!this.incoming.has(target)) this.incoming.set(target, []);
          this.incoming.get(target).push(edge);
        }
      }
    this.edgesByFile.set(key(file.uri), edges);
  }
  visible(uri) {
    const root = key(uri);
    if (this.closures.has(root)) return this.closures.get(root);
    const seen = new Set(), queue = [root];
    while (queue.length) {
      const current = queue.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      const file = this.files.get(current); if (!file) continue;
      for (const include of file.includes) {
        const adjacent = include.quoted && this.paths.get(fileKey(path.resolve(path.dirname(file.path), include.name)));
        const suffix = this.suffixes.get(fileKey(include.name.replace(/\\/g, '/'))) || [];
        // Unique suffix resolution supports project include roots without guessing
        // between two identically named headers. No host system headers are scanned.
        const target = adjacent || (suffix.length === 1 ? suffix[0] : undefined);
        if (target && !seen.has(target)) queue.push(target);
      }
    }
    this.closures.set(root, seen); return seen;
  }
  resolve(uri, name) {
    const candidates = this.names.get(name) || [], current = key(uri);
    const visible = this.visible(uri);
    // Macros can replace a function identifier; do not pretend to expand them.
    if ([...visible].some(file => this.files.get(file)?.macros.includes(name))) return [];
    const own = candidates.filter(fn => key(fn.uri) === current);
    if (own.length) return own;
    const included = candidates.filter(fn => visible.has(key(fn.uri)));
    if (included.length) return included;
    if (this.files.get(current)?.declarations?.some(declaration => declaration.static && declaration.name === name)) return [];
    return candidates.filter(fn => !fn.static);
  }
  prepare(uri, point, name) {
    const file = this.files.get(key(uri)); if (!file) return [];
    const selected = file.functions.filter(fn => inside(fn.selectionRange, point));
    if (selected.length) return selected;
    const call = file.calls.find(call => inside(call.range, point));
    if (call) return call.indirect ? [] : this.resolve(uri, call.name);
    const declaration = file.declarations?.find(declaration => inside(declaration.range, point));
    if (declaration) return this.resolve(uri, declaration.name);
    // A locked root can move when lines are inserted before its definition.
    // Never let name recovery override a live indirect call at the cursor.
    const named = name && file.functions.filter(fn => fn.name === name);
    if (named?.length === 1) return named;
    return file.functions.filter(fn => inside(fn.range, point));
  }
  item(fn) {
    return { name: fn.name, uri: fn.uri, range: fn.range, selectionRange: fn.selectionRange,
      kind: 11, detail: '本地 C 语法索引 · 条件分支未求值',
      sourceInsightInspiredLocal: { id: fn.id, generation: this.generation } };
  }
  definitions(uri, point) {
    const file = this.files.get(key(uri)); if (!file) return [];
    const own = file.functions.filter(fn => inside(fn.selectionRange, point));
    if (own.length) return own;
    const call = file.calls.find(call => inside(call.range, point));
    if (call) return !call.indirect ? this.resolve(uri, call.name) : [];
    const declaration = file.declarations?.find(declaration => inside(declaration.range, point));
    return declaration ? this.resolve(uri, declaration.name) : [];
  }
  symbols(uri) { return this.files.get(key(uri))?.symbols || []; }
  calls(item, direction) {
    const id = item.sourceInsightInspiredLocal?.id;
    if (!this.functions.has(id)) return [];
    const edges = (direction === 'incoming' ? this.incoming : this.outgoing).get(id) || [];
    const groups = new Map();
    for (const edge of edges) {
      const target = direction === 'incoming' ? this.functions.get(edge.caller)
        : edge.resolved ? this.functions.get(edge.targets[0]) : undefined;
      const groupKey = target?.id || `unresolved:${edge.name}`;
      if (!groups.has(groupKey)) {
        const result = target ? this.item(target) : {
          name: edge.name, uri: edge.file, range: edge.range, selectionRange: edge.range, kind: 11,
          detail: edge.targets.length > 1 ? '多个定义候选 · 定位调用现场' : '未解析的函数或宏 · 定位调用现场',
          sourceInsightInspiredLocal: { id: groupKey, generation: this.generation, unresolved: true }
        };
        groups.set(groupKey, direction === 'incoming' ? { from: result, fromRanges: [] } : { to: result, fromRanges: [] });
      }
      groups.get(groupKey).fromRanges.push(edge.range);
    }
    return [...groups.values()].sort((a, b) => {
      const left = direction === 'incoming' ? a.from : a.to, right = direction === 'incoming' ? b.from : b.to;
      return key(left.uri).localeCompare(key(right.uri)) || left.selectionRange.start.line - right.selectionRange.start.line || left.selectionRange.start.character - right.selectionRange.start.character;
    });
  }
  summary() {
    return { files: this.files.size, functions: this.functions.size,
      calls: [...this.outgoing.values()].reduce((n, calls) => n + calls.length, 0),
      errors: [...this.files.values()].filter(file => file.hasErrors).length, generation: this.generation };
  }
}
module.exports = { CIndex };
