'use strict';
const path = require('node:path');
const { rankSymbols } = require('./domain/symbol-search');
const { uriKey } = require('./resources');

function inside(range, point) {
  const cmp = (a, b) => a.line - b.line || a.character - b.character;
  return cmp(range.start, point) <= 0 && cmp(point, range.end) < 0;
}
function key(value) { return uriKey({ toString: () => value }); }
function fileKey(file) { return process.platform === 'win32' ? file.toLowerCase() : file; }

class CIndex {
  constructor() { this.files = new Map(); this.generation = 0; this.maxClosureEntries = 32768; this.rebuild(); }
  replace(files) { this.files = new Map(files.map(file => [key(file.uri), file])); this.rebuild(); }
  update(file) {
    const uri = key(file.uri), old = this.files.get(uri);
    if (!old || old.path !== file.path || old.project !== file.project) { this.files.set(uri, file); this.rebuild(); return; }
    const affected = new Set([uri]);
    const names = new Set([...old.functions, ...file.functions].map(fn => fn.name));
    for (const name of names) for (const caller of this.callersByName.get(name) || []) affected.add(caller);
    for (const candidate of this.dependentsOf(uri)) affected.add(candidate);
    for (const fn of old.functions) {
      this.functions.delete(fn.id);
      const remaining = (this.names.get(fn.name) || []).filter(value => value.id !== fn.id);
      if (remaining.length) this.names.set(fn.name, remaining); else this.names.delete(fn.name);
    }
    for (const name of new Set(old.calls.map(call => call.name))) this.callersByName.get(name)?.delete(uri);
    this.files.set(uri, file); this.closures.clear(); this.closureEntries = 0;
    this.buildDependencies();
    for (const fn of file.functions) {
      this.functions.set(fn.id, fn); const values = this.names.get(fn.name) || []; values.push(fn); this.names.set(fn.name, values);
    }
    for (const call of file.calls) {
      if (!this.callersByName.has(call.name)) this.callersByName.set(call.name, new Set());
      this.callersByName.get(call.name).add(uri);
    }
    for (const candidate of this.dependentsOf(uri)) affected.add(candidate);
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
    this.paths = new Map(); this.suffixes = new Map(); this.closures = new Map(); this.closureEntries = 0;
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
    this.buildDependencies();
    for (const file of this.files.values()) this.buildEdges(file);
  }
  buildDependencies() {
    this.dependencies = new Map(); this.dependents = new Map(); this.objectNames = new Set(); this.macroNames = new Set();
    for (const file of this.files.values()) {
      for (const node of file.symbols || []) if (node.kind === 12) this.objectNames.add(node.name);
      for (const name of file.macros) this.macroNames.add(name);
      const dependencies = new Set();
      for (const include of file.includes) {
        const adjacent = include.quoted && this.paths.get(fileKey(path.resolve(path.dirname(file.path), include.name)));
        const suffix = (this.suffixes.get(fileKey(include.name.replace(/\\/g, '/'))) || [])
          .filter(uri => !file.project || this.files.get(uri)?.project === file.project);
        const target = adjacent || (suffix.length === 1 ? suffix[0] : undefined);
        if (target) {
          dependencies.add(target);
          if (!this.dependents.has(target)) this.dependents.set(target, new Set());
          this.dependents.get(target).add(key(file.uri));
        }
      }
      this.dependencies.set(key(file.uri), dependencies);
    }
  }
  dependentsOf(uri) {
    const seen = new Set(), queue = [key(uri)];
    while (queue.length) {
      const current = queue.pop();
      for (const candidate of this.dependents.get(current) || []) if (!seen.has(candidate)) { seen.add(candidate); queue.push(candidate); }
    }
    return seen;
  }
  buildEdges(file) {
    if (!file) return;
      const fileUri = key(file.uri), edges = [];
      for (const call of file.calls) {
        if (!this.callersByName.has(call.name)) this.callersByName.set(call.name, new Set());
        this.callersByName.get(call.name).add(fileUri);
        if (call.indirect || this.objectBindings(file.uri, call.name, call.range.start).length) continue;
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
    if (this.closures.has(root)) {
      const cached = this.closures.get(root); this.closures.delete(root); this.closures.set(root, cached); return cached;
    }
    const seen = new Set(), queue = [root];
    while (queue.length) {
      const current = queue.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const target of this.dependencies.get(current) || []) if (!seen.has(target)) queue.push(target);
    }
    if (seen.size <= this.maxClosureEntries) {
      while (this.closures.size && (this.closureEntries + seen.size > this.maxClosureEntries || this.closures.size >= 64)) {
        const first = this.closures.keys().next().value; this.closureEntries -= this.closures.get(first).size; this.closures.delete(first);
      }
      this.closures.set(root, seen); this.closureEntries += seen.size;
    }
    return seen;
  }
  resolve(uri, name) {
    const candidates = this.names.get(name) || [], current = key(uri);
    if (!candidates.length) return [];
    if (candidates.length === 1 && !candidates[0].static && !this.macroNames.has(name) &&
      this.files.get(key(candidates[0].uri))?.project === this.files.get(current)?.project &&
      !this.files.get(current)?.declarations?.some(declaration => declaration.static && declaration.name === name)) return candidates;
    const visible = this.visible(uri);
    // Macros can replace a function identifier; do not pretend to expand them.
    if ([...visible].some(file => this.files.get(file)?.macros.includes(name))) return [];
    const own = candidates.filter(fn => key(fn.uri) === current);
    if (own.length) return own;
    const included = candidates.filter(fn => visible.has(key(fn.uri)));
    if (included.length) return included;
    if (this.files.get(current)?.declarations?.some(declaration => declaration.static && declaration.name === name)) return [];
    const project = this.files.get(current)?.project;
    return candidates.filter(fn => !fn.static && (!project || this.files.get(key(fn.uri))?.project === project));
  }
  objectBindings(uri, name, point) {
    if (!this.objectNames.has(name)) return [];
    const current = key(uri), own = this.files.get(current);
    const declared = node => node.kind === 12 && node.name === name &&
      (!point || key(node.uri) !== current || node.selectionRange.start.line < point.line ||
        node.selectionRange.start.line === point.line && node.selectionRange.start.character <= point.character);
    const local = (own?.symbols || []).filter(declared);
    if (local.length) return local;
    return [...this.visible(uri)].filter(value => value !== current).flatMap(value =>
      (this.files.get(value)?.symbols || []).filter(declared));
  }
  prepare(uri, point, name) {
    const file = this.files.get(key(uri)); if (!file) return [];
    const selected = file.functions.filter(fn => inside(fn.selectionRange, point));
    if (selected.length) return selected;
    const call = file.calls.find(call => inside(call.range, point));
    if (call) return call.indirect || this.objectBindings(uri, call.name, point).length ? [] : this.resolve(uri, call.name);
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
      sourceInsightReaderLocal: { id: fn.id, generation: this.generation } };
  }
  membersForType(uri, point, type, seen = new Set()) {
    if (!type) return [];
    if (type.children) return type.children;
    if (!type.name) return [];
    const identity = `${key(uri)}:${type.tag || 'typedef'}:${type.name}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    const file = this.files.get(key(uri)), candidates = [], local = [];
    const matches = node => node.name === type.name && (type.tag
      ? node.namespace === 'tag' && node.detail === type.tag
      : node.namespace !== 'tag' && node.detail.startsWith('typedef'));
    for (const node of file?.locals || []) if (inside(node.scope, point) && matches(node)) local.push(node);
    if (local.length) candidates.push(local[local.length - 1]);
    else {
      const values = [];
      for (const candidate of this.files.values()) {
        if (file?.project && candidate.project !== file.project) continue;
        for (const node of candidate.symbols) if (matches(node)) values.push(node);
      }
      const own = values.filter(node => key(node.uri) === key(uri));
      const visible = this.visible(uri), included = values.filter(node => visible.has(key(node.uri)));
      candidates.push(...(own.length ? own : included));
    }
    return candidates.flatMap(node => node.children?.length ? node.children
      : this.membersForType(node.uri, node.selectionRange.start, node.declaredType, new Set(seen)));
  }
  definitions(uri, point, depth = 0) {
    if (depth > 32) return [];
    const file = this.files.get(key(uri)); if (!file) return [];
    const token = file.identifiers?.find(token => inside(token.range, point));
    if (token?.namespace === 'field') {
      if (token.receiver) {
        const owners = this.definitions(uri, token.receiver, depth + 1);
        const fields = owners.flatMap(owner => this.membersForType(owner.uri, owner.selectionRange.start, owner.declaredType))
          .filter(field => field.name === token.name);
        return [...new Map(fields.map(field => [`${key(field.uri)}:${field.selectionRange.start.line}:${field.selectionRange.start.character}`, field])).values()];
      }
      const fields = [];
      const visit = nodes => { for (const node of nodes) {
        if (node.kind === 7 && inside(node.selectionRange, point)) fields.push(node);
        visit(node.children || []);
        visit(node.declaredType?.children || []);
      } };
      visit(file.symbols); visit(file.locals || []);
      return [...new Map(fields.map(field => [`${key(field.uri)}:${field.selectionRange.start.line}:${field.selectionRange.start.character}`, field])).values()];
    }
    const matches = node => {
      if (!token || node.name !== token.name || node.kind === 7) return false;
      if (token.namespace === 'tag') return node.namespace === 'tag' && node.detail === token.type.replace('_specifier', '');
      if (node.namespace === 'tag') return false;
      if (token.namespace === 'type') return node.kind === 25 || node.detail.startsWith('typedef');
      return ![9, 22, 25].includes(node.kind);
    };
    const locals = [];
    const visitLocals = (nodes, scope) => { for (const node of nodes) {
      const currentScope = node.scope || scope;
      if (currentScope && inside(currentScope, point) && matches(node)) locals.push(node);
      visitLocals(node.children || [], currentScope);
    } };
    visitLocals(file.locals || [], undefined);
    if (locals?.length) return [locals[locals.length - 1]];
    const own = file.functions.filter(fn => inside(fn.selectionRange, point));
    if (own.length) return own;
    const call = file.calls.find(call => inside(call.range, point));
    if (call) {
      const bindings = this.objectBindings(uri, call.name, point);
      if (bindings.length) return bindings;
    }
    if (call?.indirect) return [];
    if (call) {
      const functions = this.resolve(uri, call.name);
      if (functions.length) return functions;
    }
    if (!token) return [];
    const candidates = [];
    const visit = nodes => { for (const node of nodes) {
      // Fields need type-aware resolution; never match unrelated members by name.
      if (matches(node)) candidates.push(node);
      visit(node.children || []);
    } };
    const project = file.project;
    for (const candidate of this.files.values()) {
      if (!project || candidate.project === project) visit(candidate.symbols);
    }
    const visible = this.visible(uri);
    const eligible = candidates.filter(node => (![9, 21, 22, 25].includes(node.kind) || visible.has(key(node.uri))) &&
      (!node.static || visible.has(key(node.uri))) &&
      (node.category !== 'macro' || visible.has(key(node.uri))));
    const ownSymbols = eligible.filter(node => key(node.uri) === key(uri));
    const included = eligible.filter(node => visible.has(key(node.uri)));
    const selected = ownSymbols.length ? ownSymbols : included.length ? included : eligible;
    if (selected.some(node => node.kind === 11)) {
      const functions = this.resolve(uri, token.name);
      if (functions.length) return functions;
    }
    // Prefer a real variable definition over an included extern declaration.
    const definitions = eligible.filter(node => !node.declarationOnly && node.category !== 'macro');
    const values = selected.length && selected.every(node => node.declarationOnly) && definitions.length ? definitions : selected;
    const unique = new Map(values.map(node => [`${key(node.uri)}:${node.selectionRange.start.line}:${node.selectionRange.start.character}`, node]));
    return [...unique.values()];
  }
  *referenceSites(uri, point) {
    const targets = this.definitions(uri, point);
    if (targets.length !== 1) return;
    const identity = node => `${key(node.uri)}:${node.selectionRange.start.line}:${node.selectionRange.start.character}`;
    const target = targets[0], id = identity(target), project = this.files.get(key(uri))?.project;
    for (const file of this.files.values()) {
      if (project && file.project !== project) continue;
      for (const token of file.identifiers || []) {
        if (token.name !== target.name) continue;
        const resolved = this.definitions(file.uri, token.range.start);
        yield resolved.length === 1 && identity(resolved[0]) === id ? { uri: file.uri, range: token.range } : undefined;
      }
    }
  }
  includeRelations(uri, incoming = false) {
    const id = key(uri), values = incoming ? this.dependents.get(id) : this.dependencies.get(id);
    return [...(values || [])].map(value => ({ uri: this.files.get(value)?.uri || value,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }));
  }
  workspaceSymbols(query, limit = 1000) {
    const values = new Map();
    const visit = (nodes, containerName = '') => { for (const node of nodes) {
      const point = node.selectionRange.start;
      const identity = `${key(node.uri)}:${point.line}:${point.character}:${node.name}`;
      if (!values.has(identity)) values.set(identity, { name: node.name, kind: node.kind, uri: node.uri, range: node.selectionRange, containerName });
      visit(node.children || [], node.name);
    } };
    for (const file of this.files.values()) visit(file.symbols);
    return rankSymbols([...values.values()], query, Math.max(1, Math.min(limit, 1000)));
  }
  symbols(uri) { return this.files.get(key(uri))?.symbols || []; }
  callDiagnostics(item, direction) {
    const fn = this.functions.get(item.sourceInsightReaderLocal?.id), notes = [
      '本地 C 语法索引：仅直接调用，条件分支未求值；不代表完整语义调用关系'
    ];
    if (!fn) return notes;
    const file = this.files.get(key(fn.uri));
    if (file?.hasErrors) notes.push('当前文件存在语法错误，结果可能不完整');
    if (direction === 'outgoing') {
      const indirect = file.calls.filter(call => call.caller === fn.id &&
        (call.indirect || this.objectBindings(file.uri, call.name, call.range.start).length)).length;
      const unresolved = (this.outgoing.get(fn.id) || []).filter(edge => !edge.resolved).length;
      if (indirect) notes.push(`${indirect} 处间接调用未解析`);
      if (unresolved) notes.push(`${unresolved} 处直接调用目标尚未唯一确定，节点定位调用现场`);
    } else notes.push('宏展开和函数指针引用可能遗漏，可使用语言服务复查');
    return notes;
  }
  calls(item, direction) {
    const id = item.sourceInsightReaderLocal?.id;
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
          sourceInsightReaderLocal: { id: groupKey, generation: this.generation, unresolved: true }
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
