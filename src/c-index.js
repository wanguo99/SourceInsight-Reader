'use strict';
const path = require('node:path');
const { rankSymbols } = require('./domain/symbol-search');
const { uriKey } = require('./resources');
const { identifierAt, identifiersNamed } = require('./infrastructure/identifier-table');

function inside(range, point) {
  const cmp = (a, b) => a.line - b.line || a.character - b.character;
  return cmp(range.start, point) <= 0 && cmp(point, range.end) < 0;
}
function key(value) { return uriKey({ toString: () => value }); }
function fileKey(file) { return process.platform === 'win32' ? file.toLowerCase() : file; }

class CIndex {
  constructor(storage, check = () => {}) { this.storage = storage; this.check = check; this.graph = storage?.graph; this.files = new Map(); this.generation = 0; this.maxClosureEntries = 32768; this.rebuild(); }
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
    for (const name of old.callNames || new Set(old.calls.map(call => call.name))) this.callersByName.get(name)?.delete(uri);
    this.files.set(uri, file); this.closures.clear(); this.closureEntries = 0;
    this.buildDependencies();
    for (const fn of file.functions) {
      this.functions.set(fn.id, fn); const values = this.names.get(fn.name) || []; values.push(fn); this.names.set(fn.name, values);
    }
    for (const name of file.callNames || new Set(file.calls.map(call => call.name))) {
      if (!this.callersByName.has(name)) this.callersByName.set(name, new Set());
      this.callersByName.get(name).add(uri);
    }
    for (const candidate of this.dependentsOf(uri)) affected.add(candidate);
    for (const name of names) for (const caller of this.callersByName.get(name) || []) affected.add(caller);
    if (this.graph) this.graph.begin([...this.files.values()], affected);
    for (const candidate of affected) {
      if (this.graph) continue;
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
    try { for (const candidate of this.graph?.fullRebuild ? this.files.keys() : affected) this.buildEdges(this.files.get(candidate)); this.graph?.end(); }
    catch (error) { this.graph?.end(false); throw error; }
    this.generation++;
  }
  remove(uri) { this.files.delete(key(uri)); this.rebuild(); }
  rebuild() {
    this.generation++; this.functions = new Map(); this.names = new Map();
    this.paths = new Map(); this.suffixes = new Map(); this.closures = new Map(); this.closureEntries = 0;
    this.incoming = new Map(); this.outgoing = new Map(); this.edgesByFile = new Map(); this.callersByName = new Map();
    for (const file of this.files.values()) {
      this.check();
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
    if (this.graph) {
      this.outgoing.get = id => this.graph.get(id, false); this.incoming.get = id => this.graph.get(id, true);
      this.graph.begin([...this.files.values()]);
      for (const file of this.files.values()) for (const name of file.callNames || []) {
        if (!this.callersByName.has(name)) this.callersByName.set(name, new Set()); this.callersByName.get(name).add(key(file.uri));
      }
    }
    try { for (const file of this.files.values()) this.buildEdges(file); this.graph?.end(); }
    catch (error) { this.graph?.end(false); throw error; }
  }
  buildDependencies() {
    this.dependencies = new Map(); this.dependents = new Map(); this.includeLinks = new Map(); this.missingIncludes = new Map(); this.headerScopes = new Map(); this.objectNames = new Set(); this.macroNames = new Set();
    for (const file of this.files.values()) {
      this.check();
      for (const name of file.objectNames || (file.symbols || []).filter(node => node.kind === 12).map(node => node.name)) this.objectNames.add(name);
      for (const name of file.macros) this.macroNames.add(name);
      const dependencies = new Set(), links = [], missing = [];
      for (const include of file.includes) {
        const neighbor = include.quoted && this.paths.get(fileKey(path.resolve(path.dirname(file.path), include.name)));
        const sameProject = uri => (this.files.get(uri)?.project || 'workspace') === (file.project || 'workspace');
        const adjacent = neighbor && sameProject(neighbor) ? neighbor : undefined;
        const matches = this.suffixes.get(fileKey(include.name.replace(/\\/g, '/'))) || [];
        // Each workspace folder is an independent project, including nested
        // roots. An include must never borrow a different project's SDK.
        const suffix = matches.filter(sameProject);
        const target = adjacent || (suffix.length === 1 ? suffix[0] : undefined);
        if (target) {
          dependencies.add(target);
          links.push({ uri: target, range: include.range });
          if (!this.dependents.has(target)) this.dependents.set(target, new Set());
          this.dependents.get(target).add(key(file.uri));
        } else missing.push(include);
      }
      this.dependencies.set(key(file.uri), dependencies);
      this.includeLinks.set(key(file.uri), links); this.missingIncludes.set(key(file.uri), missing);
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
    if (!file || this.graph && !this.graph.needs(file)) return;
      const fileUri = key(file.uri), edges = [];
      let checked = 0;
      for (const call of file.calls) {
        if (++checked % 256 === 0) this.check();
        if (!this.callersByName.has(call.name)) this.callersByName.set(call.name, new Set());
        this.callersByName.get(call.name).add(fileUri);
        if (call.indirect || this.objectBindings(file.uri, call.name, call.range.start).length) continue;
        const candidates = this.resolve(file.uri, call.name, call.range.start);
        const resolved = candidates.length === 1;
        const edge = { ...call, file: file.uri, targets: resolved ? [candidates[0].id] : [], candidateCount: candidates.length, resolved };
        if (this.graph) { this.graph.add(edge); continue; }
        edges.push(edge);
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
  visible(uri, point) {
    const root = key(uri), roots = point ? (this.includeLinks.get(root) || []).filter(link => !link.range || link.range.start.line < point.line || link.range.start.line === point.line && link.range.start.character <= point.character) : undefined;
    const cacheKey = roots ? `${root}#includes:${roots.length}` : root;
    if (this.closures.has(cacheKey)) {
      const cached = this.closures.get(cacheKey); this.closures.delete(cacheKey); this.closures.set(cacheKey, cached); return cached;
    }
    const seen = new Set(), queue = [root];
    while (queue.length) {
      const current = queue.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      const next = current === root && roots ? roots.map(link => link.uri) : this.dependencies.get(current) || [];
      for (const target of next) if (!seen.has(target)) queue.push(target);
    }
    if (seen.size <= this.maxClosureEntries) {
      while (this.closures.size && (this.closureEntries + seen.size > this.maxClosureEntries || this.closures.size >= 64)) {
        const first = this.closures.keys().next().value; this.closureEntries -= this.closures.get(first).size; this.closures.delete(first);
      }
      this.closures.set(cacheKey, seen); this.closureEntries += seen.size;
    }
    return seen;
  }
  headerContext(uri) {
    const root = key(uri); if (this.headerScopes.has(root)) return this.headerScopes.get(root);
    const visible = new Set(), limits = new Map(), queue = [root], visited = new Set([root]); let examined = 0, complete = true;
    while (queue.length && examined < 128 && visible.size < 2048) {
      const child = queue.pop();
      for (const parent of this.dependents.get(child) || []) {
        if (++examined > 128 || visible.size >= 2048) { complete = false; break; }
        for (const edge of this.includeLinks.get(parent) || []) {
          if (edge.uri !== child || !edge.range) continue;
          const point = edge.range.start; visible.add(parent);
          if (!limits.has(parent)) limits.set(parent, []); limits.get(parent).push(point);
          // Only declarations/includes preceding this inclusion are context.
          // Never import the queried header's later includes through a cycle.
          for (const prior of this.includeLinks.get(parent) || []) if (prior.uri !== root && prior.range &&
            (prior.range.start.line < point.line || prior.range.start.line === point.line && prior.range.start.character < point.character)) {
            for (const id of this.visible(prior.uri)) {
              if (visible.size >= 2048) { complete = false; break; }
              if (id !== root) visible.add(id);
            }
          }
        }
        if (!visited.has(parent)) { visited.add(parent); queue.push(parent); }
      }
    }
    if (queue.length) complete = false;
    visible.delete(root); const context = { source: root, visible, limits, complete };
    // Header contexts can be large in generated projects. Keep only a small
    // bounded cache; the ordinary include closure retains its separate budget.
    if (this.headerScopes.size >= 8) this.headerScopes.delete(this.headerScopes.keys().next().value);
    if (visible.size <= 2048) this.headerScopes.set(root, context);
    return context;
  }
  contextualDefinitions(uri, point, depth, context) {
    if (context || !/\.(?:h|hpp|hh|hxx)$/i.test(this.files.get(key(uri))?.path || '')) return [];
    const inherited = this.headerContext(uri); if (!inherited.visible.size || !inherited.complete) return [];
    return this.definitions(uri, point, depth + 1, { ...inherited, visible: new Set([...this.visible(uri, point), ...inherited.visible]) });
  }
  candidateSymbols(name, uri, role, onlyUri, context) {
    return this.storage.findSymbols(name, this.files.get(key(uri))?.project || 'workspace', role, onlyUri);
  }
  explain(uri, point) {
    const file = this.files.get(key(uri)); if (!file) return { reason: 'notIndexed', note: '当前文件未收录，查看本地索引问题及屏蔽设置' };
    const token = this.storage ? this.storage.identifierAt(uri, point) : identifierAt(file, point);
    const missing = [];
    const visible = new Set(this.visible(uri, point));
    if (/\.(?:h|hpp|hh|hxx)$/i.test(file.path)) for (const id of this.headerContext(uri).visible) visible.add(id);
    for (const id of visible) for (const include of this.missingIncludes.get(id) || []) {
      if (id === key(uri) && include.range && (include.range.start.line > point.line || include.range.start.line === point.line && include.range.start.character > point.character)) continue;
      missing.push({ name: include.name, quoted: include.quoted, uri: this.files.get(id)?.uri, range: include.range });
    }
    const prefix = token?.name.split('_')[0].toLowerCase();
    missing.sort((a, b) => Number(Boolean(prefix && b.name.toLowerCase().startsWith(prefix))) - Number(Boolean(prefix && a.name.toLowerCase().startsWith(prefix))) || Number(b.quoted) - Number(a.quoted));
    const includes = [...new Map(missing.map(value => [value.name, value])).values()].slice(0, 8);
    return { reason: file.requiresSemantic ? 'needsSemantic' : includes.length ? 'unresolvedInclude' : 'notFound', symbol: token?.name, includes,
      note: `${token?.name ? `未找到 ${token.name} 的可确定定义。` : '未找到可确定定义。'}${includes.length ? `本地尚未收录头文件：${includes.map(value => value.name).join('、')}；请在当前项目中提供对应 SDK，或为该项目的语言服务配置编译数据库。不会使用其他工作区根的 SDK。` : '请检查条件编译、作用域及语言服务配置。'}` };
  }
  resolve(uri, name, point) {
    const current = key(uri), project = this.files.get(current)?.project || 'workspace';
    const candidates = (this.names.get(name) || []).filter(fn => (this.files.get(key(fn.uri))?.project || 'workspace') === project);
    if (!candidates.length) return [];
    if (candidates.length === 1 && !candidates[0].static && !this.macroNames.has(name) &&
      this.files.get(key(candidates[0].uri))?.project === this.files.get(current)?.project &&
      !this.files.get(current)?.declarations?.some(declaration => declaration.static && declaration.name === name)) return candidates;
    const visible = this.visible(uri, point);
    // Macros can replace a function identifier; do not pretend to expand them.
    const ownFile = this.files.get(current), before = position => !point || position.line < point.line || position.line === point.line && position.character <= point.character;
    const undefs = (ownFile?.undefs || []).filter(event => event.name === name && !event.conditional && before(event.range.start));
    const lastUndef = undefs.at(-1)?.range.start;
    const afterUndef = position => !lastUndef || position.line > lastUndef.line || position.line === lastUndef.line && position.character > lastUndef.character;
    if ([...visible].some(id => {
      const file = this.files.get(id); if (!file?.macros.includes(name)) return false;
      if (id !== current) return !lastUndef;
      const positions = file.macroLocations?.[name];
      return positions ? positions.some(position => before(position) && afterUndef(position)) : !lastUndef;
    })) return [];
    const own = candidates.filter(fn => key(fn.uri) === current);
    if (own.length) return own;
    const included = candidates.filter(fn => visible.has(key(fn.uri)));
    if (included.length) return included;
    if (this.files.get(current)?.declarations?.some(declaration => declaration.static && declaration.name === name)) return [];
    return candidates.filter(fn => !fn.static);
  }
  objectBindings(uri, name, point) {
    if (!this.objectNames.has(name)) return [];
    const current = key(uri), own = this.files.get(current);
    const declared = node => node.kind === 12 && node.name === name &&
      (!point || key(node.uri) !== current || node.selectionRange.start.line < point.line ||
        node.selectionRange.start.line === point.line && node.selectionRange.start.character <= point.character);
    const local = (this.storage ? this.candidateSymbols(name, uri, 'top', uri) : own?.symbols || []).filter(declared);
    if (local.length) return local;
    if (this.storage) { const visible = this.visible(uri, point); return this.candidateSymbols(name, uri, 'top').filter(node => visible.has(key(node.uri)) && key(node.uri) !== current && declared(node)); }
    return [...this.visible(uri, point)].filter(value => value !== current).flatMap(value => (this.files.get(value)?.symbols || []).filter(declared));
  }
  prepare(uri, point, name) {
    const file = this.files.get(key(uri)); if (!file) return [];
    const selected = file.functions.filter(fn => inside(fn.selectionRange, point));
    if (selected.length) return selected;
    const call = file.calls.find(call => inside(call.range, point));
    if (call) return call.indirect || this.objectBindings(uri, call.name, point).length ? [] : this.resolve(uri, call.name, point);
    const declaration = file.declarations?.find(declaration => inside(declaration.range, point));
    if (declaration) return this.resolve(uri, declaration.name, point);
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
  membersForType(uri, point, type, seen = new Set(), context) {
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
    for (const node of this.storage ? this.storage.localSymbols(uri, type.name) : file?.locals || []) if (inside(node.scope, point) && matches(node)) local.push(node);
    if (local.length) candidates.push(local[local.length - 1]);
    else {
      const values = [];
      const visible = context?.source === key(uri) ? context.visible : this.visible(uri, point);
      if (this.storage) values.push(...this.candidateSymbols(type.name, uri, undefined, undefined, context).filter(matches));
      else for (const candidate of this.files.values()) {
        if ((candidate.project || 'workspace') !== (file?.project || 'workspace')) continue;
        for (const node of candidate.symbols) if (matches(node)) values.push(node);
      }
      const own = values.filter(node => key(node.uri) === key(uri));
      const included = values.filter(node => visible.has(key(node.uri)));
      candidates.push(...(own.length ? own : included));
    }
    return candidates.flatMap(node => node.children?.length ? node.children
      : this.membersForType(node.uri, node.selectionRange.start, node.declaredType, new Set(seen), context));
  }
  definitions(uri, point, depth = 0, context) {
    if (depth > 32) return [];
    const file = this.files.get(key(uri)); if (!file) return [];
    const macrosOnly = Boolean(file.requiresSemantic);
    const token = this.storage ? this.storage.identifierAt(uri, point) : identifierAt(file, point);
    const inPreprocessor = (file.preprocessorRanges || []).some(range => inside(range, point));
    if (token?.namespace === 'field') {
      const typed = file.fieldTypes?.[`${token.range.start.line}:${token.range.start.character}`];
      if (typed) {
        let members = this.membersForType(uri, point, typed.type, new Set(), context);
        for (const name of typed.members) members = members.filter(node => node.name === name).flatMap(node => this.membersForType(node.uri, point, node.declaredType, new Set(), context));
        const values = [...new Map(members.filter(node => node.name === token.name).map(node => [`${key(node.uri)}:${node.selectionRange.start.line}:${node.selectionRange.start.character}`, node])).values()];
        return values.length ? values : this.contextualDefinitions(uri, point, depth, context);
      }
      if (token.receiver) {
        const owners = this.definitions(uri, token.receiver, depth + 1, context);
        const fields = owners.flatMap(owner => this.membersForType(owner.uri, owner.selectionRange.start, owner.declaredType, new Set(), context))
          .filter(field => field.name === token.name);
        const values = [...new Map(fields.map(field => [`${key(field.uri)}:${field.selectionRange.start.line}:${field.selectionRange.start.character}`, field])).values()];
        return values.length ? values : this.contextualDefinitions(uri, point, depth, context);
      }
      if (this.storage) return this.storage.symbolAt(uri, point).filter(node => node.kind === 7);
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
      if (macrosOnly && !['macro', 'macroParameter'].includes(node.category)) return false;
      if (token.namespace === 'tag') return node.namespace === 'tag' && node.detail === token.type.replace('_specifier', '');
      if (node.namespace === 'tag') return false;
      if (token.namespace === 'type') return node.kind === 25 || node.detail.startsWith('typedef');
      return inPreprocessor || ![9, 22, 25].includes(node.kind);
    };
    const locals = [];
    const visitLocals = (nodes, scope) => { for (const node of nodes) {
      const currentScope = node.scope || scope;
      if (currentScope && inside(currentScope, point) && matches(node)) locals.push(node);
      visitLocals(node.children || [], currentScope);
    } };
    visitLocals(this.storage ? this.storage.localSymbols(uri, token?.name) : file.locals || [], undefined);
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
      const functions = this.resolve(uri, call.name, point);
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
    const visible = context?.visible || this.visible(uri, point);
    if (this.storage) candidates.push(...this.candidateSymbols(token.name, uri, undefined, undefined, context).filter(node => (!this.files.get(key(node.uri))?.requiresSemantic || node.category === 'macro') && !node.scope && matches(node)));
    else for (const candidate of this.files.values()) { if ((candidate.project || 'workspace') === (project || 'workspace')) visit(candidate.requiresSemantic ? candidate.symbols.filter(node => node.category === 'macro') : candidate.symbols); }
    const macroDeclaration = candidates.filter(node => node.category === 'macro' && key(node.uri) === key(uri) && inside(node.selectionRange, point));
    if (macroDeclaration.length) return macroDeclaration;
    const eligible = candidates.filter(node => (![9, 21, 22, 25].includes(node.kind) || visible.has(key(node.uri))) &&
      (!node.static || visible.has(key(node.uri))) &&
      (node.category !== 'macro' || visible.has(key(node.uri)) &&
        (key(node.uri) !== key(uri) || node.selectionRange.start.line < point.line || node.selectionRange.start.line === point.line && node.selectionRange.start.character <= point.character) &&
        !(file.undefs || []).some(event => !event.conditional && event.name === node.name &&
          (event.range.start.line < point.line || event.range.start.line === point.line && event.range.start.character < point.character) &&
          (key(node.uri) !== key(uri) || event.range.start.line > node.selectionRange.start.line))) &&
      (!context?.limits.has(key(node.uri)) || context.limits.get(key(node.uri)).some(limit =>
        (node.selectionRange.start.line < limit.line || node.selectionRange.start.line === limit.line && node.selectionRange.start.character <= limit.character) &&
        (node.category !== 'macro' || !(this.files.get(key(node.uri))?.undefs || []).some(event => event.name === node.name && !event.conditional &&
          event.range.start.line > node.selectionRange.start.line && event.range.start.line < limit.line)))));
    const ownSymbols = eligible.filter(node => key(node.uri) === key(uri));
    const included = eligible.filter(node => visible.has(key(node.uri)));
    const selected = ownSymbols.length ? ownSymbols : included.length ? included : eligible;
    if (selected.some(node => node.kind === 11)) {
      const functions = this.resolve(uri, token.name, point);
      if (functions.length) return functions;
    }
    // Prefer a real variable definition over an included extern declaration.
    const definitions = eligible.filter(node => !node.declarationOnly && node.category !== 'macro');
    const values = selected.length && selected.every(node => node.declarationOnly) && definitions.length ? definitions : selected;
    const unique = new Map(values.map(node => [`${key(node.uri)}:${node.selectionRange.start.line}:${node.selectionRange.start.character}`, node]));
    return unique.size ? [...unique.values()] : this.contextualDefinitions(uri, point, depth, context);
  }
  *referenceSites(uri, point) {
    const targets = this.definitions(uri, point);
    if (targets.length !== 1) return;
    const identity = node => `${key(node.uri)}:${node.selectionRange.start.line}:${node.selectionRange.start.character}`;
    const target = targets[0], id = identity(target), project = this.files.get(key(uri))?.project;
    if (this.storage) {
      for (const token of this.storage.occurrences(target.name, project || 'workspace')) {
        if (target.scope && key(token.uri) !== key(target.uri)) continue;
        const resolved = this.definitions(token.uri, token.range.start);
        yield resolved.length === 1 && identity(resolved[0]) === id ? { uri: token.uri, range: token.range } : undefined;
      }
      return;
    }
    for (const file of this.files.values()) {
      if ((file.project || 'workspace') !== (project || 'workspace')) continue;
      if (target.scope && key(file.uri) !== key(target.uri)) continue;
      for (const token of identifiersNamed(file, target.name)) {
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
    if (this.storage) return this.storage.workspaceSymbols(query, limit);
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
    if (file?.declarationsOnly) notes.push('大文件仅收录顶层定义/声明；函数体和调用关系未索引，请使用语言服务复查');
    if (file?.hasErrors) notes.push('当前文件含未完整解析的 C 语法或宏，已保留可识别符号，结果可能不完整');
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
          detail: edge.candidateCount > 1 ? '多个定义候选 · 定位调用现场' : '未解析的函数或宏 · 定位调用现场',
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
      calls: this.graph ? this.graph.count() : [...this.outgoing.values()].reduce((n, calls) => n + calls.length, 0),
      errors: [...this.files.values()].filter(file => file.hasErrors).length,
      limitedFiles: [...this.files.values()].filter(file => file.declarationsOnly).length,
      outlineFiles: [...this.files.values()].filter(file => file.requiresSemantic).length, warnings: [...this.files.values()].filter(file => file.warnings?.length).length, generation: this.generation };
  }
}
module.exports = { CIndex };
