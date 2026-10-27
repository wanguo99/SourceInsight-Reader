'use strict';
const crypto = require('node:crypto');
const { ProjectIndexLock, requestUpdate, pendingUpdates } = require('./project-index-lock');
const { IndexDatabase, databasePath } = require('./index-database');
const { identifierAt, identifiersNamed } = require('./identifier-table');
const { InheritedIndexCache } = require('./inherited-index-cache');
const factFields = new Set(['functions', 'symbols', 'calls', 'locals', 'identifierNames', 'identifierData', 'declarations', 'macros', 'macroLocations', 'fieldTypes', 'preprocessorRanges', 'undefs', '__proto__', 'constructor', 'prototype']);

class FileFactsView {
  constructor(metadata, store) {
    this._metadata = metadata; this._store = store;
    Object.defineProperty(this, '_metadata', { enumerable: false }); Object.defineProperty(this, '_store', { enumerable: false });
    for (const [key, value] of Object.entries(metadata)) if (!key.startsWith('_') && !factFields.has(key)) this[key] = value;
  }
  get functions() { return this._store.functionsNamed(undefined, this._metadata.uri); }
  get symbols() { const file = this._metadata; return file.streamedDirectives || file.symbolCount > 5000 ? this._store.documentSymbols(file.uri) : this._store.fileFacts(file.uri)?.symbols || []; }
  get calls() { const file = this._metadata; return file.functionCount === 0 || file.callCount === 0 ? [] : this._store.fileFacts(file.uri)?.calls || []; }
  get locals() { return this._store.fileFacts(this._metadata.uri)?.locals || []; }
  get identifierNames() { return this._store.fileFacts(this._metadata.uri)?.identifierNames || []; }
  get identifierData() { return this._store.fileFacts(this._metadata.uri)?.identifierData || []; }
  get declarations() { return this._store.fileFacts(this._metadata.uri)?.declarations || []; }
  get macros() { return this._store.fileFacts(this._metadata.uri)?.macros || []; }
  get macroLocations() { return this._store.fileFacts(this._metadata.uri)?.macroLocations || []; }
  get fieldTypes() { return this._store.fileFacts(this._metadata.uri)?.fieldTypes || []; }
  get preprocessorRanges() { return this._store.fileFacts(this._metadata.uri)?.preprocessorRanges || []; }
  get undefs() { return this._metadata.undefs || this._store.fileFacts(this._metadata.uri)?.undefs || []; }
}

class SqliteIndexRepository {
  constructor(directory, parserId, report = message => {}) {
    this.directory = directory; this.parserId = parserId; this.report = report; this.stores = new Map(); this.files = new Map(); this.owner = new Map(); this.isSqlite = true;
    this.graph = new PersistentGraph(this);
    this.overlays = new Map(); this.writerLocks = new Map(); this.readers = new Set(); this.sharedRevisions = new Map();
    this.inherited = new InheritedIndexCache(directory, parserId, report);
    const repository = this;
    this.functionMap = {
      get size() { return [...repository.stores.values()].reduce((sum, store) => sum + store.functionCount(), 0) +
        [...repository.overlays.values()].reduce((sum, file) => sum + file.functions.length - repository.forUri(file.uri).functionsNamed(undefined, file.uri).length, 0); },
      get: id => repository.functionById(id), has: id => Boolean(repository.functionById(id)),
      *values() { for (const store of repository.stores.values()) for (const fn of store.functionRecords()) if (!repository.overlays.has(fn.uri)) yield fn;
        for (const file of repository.overlays.values()) yield* file.functions; }
    };
    this.functionNames = { get: name => this.functionsNamed(name) };
    this.callersByName = { get: name => this.callingFiles(name) };
  }
  async open(file, force, options = {}) {
    this.files.clear(); this.overlays.clear(); this.owner.clear(); this.loadingLimited = false;
    for (const store of this.stores.values()) { store.cache.clear(); store.cacheBytes = 0; }
    const groups = new Map();
    for (const descriptor of options.descriptors || []) {
      const project = descriptor.project || 'workspace';
      if (!groups.has(project)) groups.set(project, []); groups.get(project).push(descriptor.uri); this.owner.set(descriptor.uri, project);
    }
    for (const [project, store] of this.stores) if (!groups.has(project) || this.readers.has(project)) { store.close(); this.stores.delete(project); if (!groups.has(project)) { this.writerLocks.get(project)?.close(); this.writerLocks.delete(project); this.readers.delete(project); } }
    this.graph.prune(new Set(groups.keys()));
    for (const [project, uris] of groups) {
      const store = this.store(project); store.activate(uris);
      const admitted = [];
      for (const metadata of store.metadataRecords()) {
        if (options.canLoad && !options.canLoad()) { this.loadingLimited = true; break; }
        this.files.set(metadata.uri, this.view(metadata, store)); admitted.push(metadata.uri);
      }
      if (this.loadingLimited) store.activate(admitted);
    }
    await this.inherited.discover(force ? [] : (options.descriptors || []).filter(file => !this.readOnly(file.uri) && !this.files.has(file.uri)));
  }
  store(project) {
    if (!this.stores.has(project)) {
      let store;
      try {
        const file = databasePath(this.directory, project);
        let lock = this.writerLocks.get(project);
        if (!lock) { lock = new ProjectIndexLock(file); this.writerLocks.set(project, lock); }
        const writable = lock.acquire();
        if (writable) this.readers.delete(project); else this.readers.add(project);
        try { store = new IndexDatabase(file, project, this.parserId, this.report, !writable); }
        catch (error) {
          if (writable) throw error;
          this.report(`共享索引尚不可读，等待写入窗口：${error.message}`);
          store = new IndexDatabase(':memory:', project, this.parserId, this.report);
          store.readOnly = true;
        }
        this.sharedRevisions.set(project, this.sharedVersion(store));
      }
      catch (error) {
        if (!/EACCES|EPERM|EROFS|ENOTDIR|SQLITE_CANTOPEN|INDEX_CACHE_DELETING|unable to open|readonly|disk is full/i.test(error.code + ' ' + error.message)) throw error;
        this.report(`缓存目录不可写，当前工程使用临时内存索引：${error.message}`);
        store = new IndexDatabase(':memory:', project, this.parserId, this.report);
      }
      this.stores.set(project, store);
    }
    return this.stores.get(project);
  }
  refreshSharedFile(uri) {
    const store = this.forUri(uri), metadata = store?.fileMetadata(uri);
    this.overlays.delete(uri);
    if (!metadata) { this.files.delete(uri); return undefined; }
    store.evict(uri); const value = this.view(metadata, store); this.files.set(uri, value); return value;
  }
  requestUpdate(uri) {
    const project = this.owner.get(uri);
    if (project && this.readers.has(project)) requestUpdate(databasePath(this.directory, project), uri);
  }
  sharedVersion(store) { return `${store.meta('revision')}:${store.statement("SELECT group_concat(graph_key || ':' || ready) AS version FROM graphs").get().version || ''}`; }
  sharedChanges() {
    let refresh = false; const requests = [];
    for (const [project, store] of this.stores) {
      if (this.readers.has(project)) {
        if (this.writerLocks.get(project)?.acquire() || store.path === ':memory:' || this.sharedVersion(store) !== this.sharedRevisions.get(project)) refresh = true;
      } else requests.push(...pendingUpdates(databasePath(this.directory, project)));
    }
    return { refresh, requests };
  }
  readOnly(uri) { return this.readers.has(this.owner.get(uri)); }
  forUri(uri) { const project = this.owner.get(uri); return project && this.store(project); }
  view(metadata, store) { return new FileFactsView(metadata, store); }
  bind(previous, descriptor, stamp = previous.stamp) {
    if (previous._inherited) return { ...previous, stamp, project: descriptor.project, scopeKey: descriptor.scopeKey, indexExclude: descriptor.indexExclude };
    if (previous._metadata && previous.stamp === stamp && (descriptor.project || previous.project) === previous.project && descriptor.scopeKey === previous.scopeKey && descriptor.indexExclude === previous.indexExclude) return previous;
    const metadata = { ...(previous._metadata || previous), stamp, project: descriptor.project || previous.project, scopeKey: descriptor.scopeKey, indexExclude: descriptor.indexExclude };
    return this.view(metadata, this.forUri(previous.uri));
  }
  get(uri) { return this.files.get(uri); }
  reusable(file) {
    // A bounded directory load may omit this file from RAM even though its
    // own durable facts are current. Recover the thin view before parsing.
    const store = this.forUri(file.uri);
    try {
      const metadata = store?.fileMetadata(file.uri);
      if (metadata) {
        if (metadata.uri !== file.uri || !Number.isInteger(metadata.functionCount) || !Array.isArray(metadata.includes)) throw new Error('Invalid file metadata');
        return this.view(metadata, store);
      }
    } catch (error) { if (!this.readOnly(file.uri)) store?.delete(file.uri, true); this.report(`单文件元数据缓存已损坏，将重新解析：${file.uri}`); }
    return this.inherited.take(file);
  }
  finishReuse() { this.inherited.close(); }
  functionById(id) {
    if (!id) return undefined;
    const uri = id.slice(0, id.lastIndexOf('#')), overlay = this.overlays.get(uri);
    return overlay ? overlay.functions.find(fn => fn.id === id) : this.forUri(uri)?.functionById(id);
  }
  functionsNamed(name) {
    const result = [...this.stores.values()].flatMap(store => store.functionsNamed(name)).filter(fn => !this.overlays.has(fn.uri));
    for (const file of this.overlays.values()) result.push(...file.functions.filter(fn => fn.name === name));
    return result;
  }
  callingFiles(name) {
    const result = new Set([...this.stores.values()].flatMap(store => store.callingFiles(name)).filter(uri => !this.overlays.has(uri)));
    for (const file of this.overlays.values()) if (file.calls.some(call => call.name === name)) result.add(file.uri);
    return result;
  }
  topNames(kind) { return { has: name => [...this.stores.values()].some(store => store.hasTopSymbol(name, kind)) ||
    [...this.overlays.values()].some(file => file.symbols.some(node => node.name === name && node.kind === kind)) }; }
  macroPositions(uri, name) {
    const overlay = this.overlays.get(uri);
    return overlay ? overlay.symbols.filter(node => node.category === 'macro' && node.name === name).map(node => node.selectionRange.start) : this.forUri(uri)?.macroPositions(uri, name) || [];
  }
  macroSites(name, project) {
    const store = this.stores.get(project), result = (store?.macroSites(name) || []).filter(site => !this.overlays.has(site.uri));
    for (const file of this.overlays.values()) if (file.project === project) {
      for (const node of file.symbols) if (node.category === 'macro' && node.name === name) result.push({ uri: file.uri, position: node.selectionRange.start });
    }
    return result;
  }
  inPreprocessor(uri, point) {
    const file = this.overlays.get(uri);
    if (!file) return this.forUri(uri)?.inPreprocessor(uri, point) || false;
    const compare = (a, b) => a.line - b.line || a.character - b.character;
    return (file.preprocessorRanges || []).some(range => compare(range.start, point) <= 0 && compare(point, range.end) < 0);
  }
  stage(file, check = () => {}) {
    if (this.readOnly(file.uri)) return this.files.get(file.uri);
    this.overlays.delete(file.uri);
    const previous = this.files.get(file.uri);
    if (previous && previous.hash === file.hash && JSON.stringify(previous.stamp) === JSON.stringify(file.stamp) && (file._directiveSource === undefined || previous.streamedDirectives)) {
      const value = this.bind(previous, file); this.files.set(file.uri, value); return value;
    }
    const project = file.project || this.owner.get(file.uri) || 'workspace'; this.owner.set(file.uri, project);
    const store = this.store(project);
    store.include(file.uri);
    if (file._directiveSource !== undefined) {
      const metadata = store.writeDirectiveSource(file, file._directiveSource, check), value = this.view(metadata, store);
      this.files.set(file.uri, value); return value;
    }
    if (file._metadata && (previous?.hash === file.hash || store.fileMetadata(file.uri)?.hash === file.hash)) {
      const metadata = { ...file._metadata, project }; store.updateMetadata(file.uri, metadata);
      const value = this.view(metadata, store); this.files.set(file.uri, value); return value;
    }
    store.publish({ uri: file.uri, hash: file.hash, provider: 'local', kind: 'facts', quality: file.hasErrors ? 'partial' : 'syntax', facts: { ...file, project } });
    const value = this.view(store.fileMetadata(file.uri), store); this.files.set(file.uri, value); return value;
  }
  overlay(file) { const project = file.project || this.owner.get(file.uri) || 'workspace'; this.overlays.set(file.uri, { functions: [], ...file, project }); this.owner.set(file.uri, project); }
  state(file, status, message) { if (this.readOnly(file.uri)) return; const store = this.forUri(file.uri); store?.state(file.uri, file.language || (/\.(?:cc|cpp|cxx|hpp|hh|hxx)$/i.test(file.path) ? 'cpp' : 'c'), status, message); }
  remove(uri, localOnly = false) { this.files.delete(uri); this.overlays.delete(uri); if (!this.readOnly(uri)) this.forUri(uri)?.delete(uri, localOnly); if (!localOnly) this.forUri(uri)?.exclude(uri); }
  prune(live) { for (const uri of this.files.keys()) if (!live.has(uri)) this.files.delete(uri); }
  pause() {}
  trimCaches() { for (const store of this.stores.values()) { store.cache.clear(); store.cacheBytes = 0; store.searchCache.clear(); store.clearCatalog(); } }
  resume() {}
  async flush() { for (const store of this.stores.values()) store.flush(); }
  close() { this.inherited.close(); for (const store of this.stores.values()) store.close(); for (const lock of this.writerLocks.values()) lock.close(); this.writerLocks.clear(); this.stores.clear(); this.graph.close(); }
  overlaySymbols(file, role) {
    const values = [];
    const visit = (nodes, currentRole, inheritedScope) => { for (const node of nodes) {
      const value = { ...node, ...(inheritedScope && !node.scope ? { scope: inheritedScope } : {}) };
      if (!role || currentRole === role) values.push(value);
      visit(node.children || [], currentRole === 'local' ? 'local' : 'member', node.scope || inheritedScope);
      visit(node.declaredType?.children || [], 'member', node.scope || inheritedScope);
    } };
    visit(file.symbols, 'top', undefined); visit(file.locals || [], 'local', undefined); return values;
  }
  findSymbols(name, project, role, uri) {
    const stores = project ? [this.stores.get(project)].filter(Boolean) : [...this.stores.values()];
    const persisted = stores.flatMap(store => store.findSymbols(name, role, uri)).filter(node => !this.overlays.has(node.uri));
    for (const file of this.overlays.values()) if ((!project || file.project === project) && (!uri || file.uri === uri)) {
      persisted.push(...this.overlaySymbols(file, role).filter(node => node.name === name));
    }
    return persisted;
  }
  localSymbols(uri, name) { return name ? this.findSymbols(name, this.owner.get(uri), 'local', uri) : []; }
  symbolAt(uri, point) {
    const file = this.overlays.get(uri);
    return file ? this.overlaySymbols(file).filter(node => node.selectionRange.start.line === point.line && node.selectionRange.start.character <= point.character && node.selectionRange.end.character > point.character) : this.forUri(uri)?.symbolAt(uri, point) || [];
  }
  identifierAt(uri, point) { const file = this.overlays.get(uri); return file ? identifierAt(file, point) : this.forUri(uri)?.identifierAt(uri, point); }
  *occurrences(name, project) {
    for (const store of project ? [this.stores.get(project)].filter(Boolean) : this.stores.values()) for (const token of store.occurrences(name)) if (!this.overlays.has(token.uri)) yield token;
    for (const file of this.overlays.values()) if (!project || project === file.project) for (const token of identifiersNamed(file, name)) yield { uri: file.uri, ...token };
  }
  workspaceSymbols(query, limit) {
    const { rankSymbols } = require('../domain/symbol-search');
    const values = [...this.stores.values()].flatMap(store => store.search(query, limit)).filter(node => !this.overlays.has(node.uri));
    for (const file of this.overlays.values()) for (const node of this.overlaySymbols(file, 'top')) values.push({ name: node.name, kind: node.kind, uri: file.uri, range: node.selectionRange, containerName: '' });
    return rankSymbols(values, query, limit);
  }
  diagnostics() { return { engine: 'sqlite', projects: this.stores.size, cachedFiles: this.files.size,
    sharedProjects: this.readers.size,
    volatileProjects: [...this.stores].filter(([project, store]) => !this.readers.has(project) && store.path === ':memory:').length,
    cachedFactFiles: [...this.stores.values()].reduce((sum, store) => sum + store.cache.size, 0), factCacheBytes: [...this.stores.values()].reduce((sum, store) => sum + store.cacheBytes, 0) }; }
}

class PersistentGraph {
  constructor(repository) { this.repository = repository; this.suspended = false; this.keys = new Map(); this.writing = new Map(); this.selected = new Map(); this.volatile = new Map(); }
  prune(projects) {
    for (const [project, store] of this.volatile) if (!projects.has(project)) { store.close(); this.volatile.delete(project); }
    for (const project of this.keys.keys()) if (!projects.has(project)) { this.keys.delete(project); this.selected.delete(project); }
  }
  begin(files, affected) {
    this.fullRebuild = false;
    const groups = new Map(), previous = this.keys, oldStores = this.selected; this.keys = new Map(); this.selected = new Map(); this.writing.clear();
    for (const file of files) { const project = file.project || 'workspace'; if (!groups.has(project)) groups.set(project, []); groups.get(project).push(`${file.uri}:${file.hash}`); }
    try {
      for (const [project, values] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
        const key = crypto.createHash('sha256').update('call-graph-4-project-includes\n' + values.sort().join('\n')).digest('hex'); this.keys.set(project, key);
        const dirty = [...this.repository.overlays.values()].some(file => file.project === project);
        if (dirty && !this.volatile.has(project)) this.volatile.set(project, new IndexDatabase(':memory:', project, this.repository.parserId));
        const store = dirty ? this.volatile.get(project) : this.repository.store(project);
        if (dirty) store.activate(files.filter(file => file.project === project).map(file => file.uri));
        this.selected.set(project, store);
        if (!store.graphReady(key) && !store.readOnly && !this.suspended) {
          const oldKey = oldStores.get(project) === store && store.graphReady(previous.get(project) || '') ? previous.get(project) : undefined;
          if (!oldKey) this.fullRebuild = true;
          store.beginGraph(key, oldKey, affected);
          this.writing.set(project, store);
        }
      }
    } catch (error) { this.end(false); this.keys = previous; this.selected = oldStores; throw error; }
    return this.writing.size > 0;
  }
  needs(file) { return this.writing.has(file.project || 'workspace'); }
  add(edge) { const project = this.repository.owner.get(edge.file) || 'workspace'; this.writing.get(project)?.addEdge(this.keys.get(project), edge); }
  end(success = true) { for (const [project, store] of this.writing) store.endGraph(this.keys.get(project), success); this.writing.clear(); }
  get(id, incoming) {
    const uri = id.slice(0, id.lastIndexOf('#')), project = this.repository.owner.get(uri), store = this.selected.get(project);
    return store ? store.edgeList(this.keys.get(project), id, incoming) : [];
  }
  count() { let count = 0; for (const [project, key] of this.keys) count += this.selected.get(project).edgeCount(key); return count; }
  close() { for (const store of this.volatile.values()) store.close(); this.volatile.clear(); }
}
module.exports = { SqliteIndexRepository };
