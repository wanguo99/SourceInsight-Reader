'use strict';
const crypto = require('node:crypto');
const { IndexDatabase, databasePath } = require('./index-database');
const { identifierAt, identifiersNamed } = require('./identifier-table');
const { InheritedIndexCache } = require('./inherited-index-cache');

class SqliteIndexRepository {
  constructor(directory, parserId, report = message => {}) {
    this.directory = directory; this.parserId = parserId; this.report = report; this.stores = new Map(); this.files = new Map(); this.owner = new Map(); this.isSqlite = true;
    this.graph = new PersistentGraph(this);
    this.overlays = new Map();
    this.inherited = new InheritedIndexCache(directory, parserId, report);
  }
  async open(file, force, options = {}) {
    this.files.clear(); this.overlays.clear(); this.owner.clear(); this.loadingLimited = false;
    for (const store of this.stores.values()) { store.cache.clear(); store.cacheBytes = 0; }
    const groups = new Map();
    for (const descriptor of options.descriptors || []) {
      const project = descriptor.project || 'workspace';
      if (!groups.has(project)) groups.set(project, []); groups.get(project).push(descriptor.uri); this.owner.set(descriptor.uri, project);
    }
    for (const [project, store] of this.stores) if (!groups.has(project)) { store.close(); this.stores.delete(project); }
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
    await this.inherited.discover(force ? [] : (options.descriptors || []).filter(file => !this.files.has(file.uri)));
  }
  store(project) {
    if (!this.stores.has(project)) {
      let store;
      try { store = new IndexDatabase(databasePath(this.directory, project), project, this.parserId, this.report); }
      catch (error) {
        if (!/EACCES|EPERM|EROFS|ENOTDIR|SQLITE_CANTOPEN|unable to open|readonly|disk is full/i.test(error.code + ' ' + error.message)) throw error;
        this.report(`缓存目录不可写，当前工程使用临时内存索引：${error.message}`);
        store = new IndexDatabase(':memory:', project, this.parserId, this.report);
      }
      this.stores.set(project, store);
    }
    return this.stores.get(project);
  }
  forUri(uri) { const project = this.owner.get(uri); return project && this.store(project); }
  view(metadata, store) {
    const value = { ...metadata };
    Object.defineProperty(value, '_metadata', { value: metadata });
    for (const key of ['symbols', 'locals', 'calls', 'identifierNames', 'identifierData']) Object.defineProperty(value, key, {
      configurable: true, get: () => store.fileFacts(metadata.uri)?.[key] || []
    });
    return value;
  }
  bind(previous, descriptor, stamp = previous.stamp) {
    if (previous._inherited) return { ...previous, stamp, project: descriptor.project, scopeKey: descriptor.scopeKey, indexExclude: descriptor.indexExclude };
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
        if (metadata.uri !== file.uri || !Array.isArray(metadata.functions) || !Array.isArray(metadata.includes) || !Array.isArray(metadata.macros)) throw new Error('Invalid file metadata');
        return this.view(metadata, store);
      }
    } catch (error) { store?.delete(file.uri, true); this.report(`单文件元数据缓存已损坏，将重新解析：${file.uri}`); }
    return this.inherited.take(file);
  }
  finishReuse() { this.inherited.close(); }
  stage(file) {
    this.overlays.delete(file.uri);
    const previous = this.files.get(file.uri);
    if (previous && previous.hash === file.hash && JSON.stringify(previous.stamp) === JSON.stringify(file.stamp)) {
      const value = this.bind(previous, file); this.files.set(file.uri, value); return value;
    }
    const project = file.project || this.owner.get(file.uri) || 'workspace'; this.owner.set(file.uri, project);
    const store = this.store(project);
    store.include(file.uri);
    if (file._metadata && (previous?.hash === file.hash || store.fileMetadata(file.uri)?.hash === file.hash)) {
      const metadata = { ...file._metadata, project }; store.updateMetadata(file.uri, metadata);
      const value = this.view(metadata, store); this.files.set(file.uri, value); return value;
    }
    store.publish({ uri: file.uri, hash: file.hash, provider: 'local', kind: 'facts', quality: file.hasErrors ? 'partial' : 'syntax', facts: { ...file, project } });
    const value = this.view(store.fileMetadata(file.uri), store); this.files.set(file.uri, value); return value;
  }
  overlay(file) { const project = file.project || this.owner.get(file.uri) || 'workspace'; this.overlays.set(file.uri, { ...file, project }); this.owner.set(file.uri, project); }
  state(file, status, message) { const store = this.forUri(file.uri); store?.state(file.uri, file.language || (/\.(?:cc|cpp|cxx|hpp|hh|hxx)$/i.test(file.path) ? 'cpp' : 'c'), status, message); }
  remove(uri, localOnly = false) { this.files.delete(uri); this.overlays.delete(uri); this.forUri(uri)?.delete(uri, localOnly); if (!localOnly) this.forUri(uri)?.exclude(uri); }
  prune(live) { for (const uri of this.files.keys()) if (!live.has(uri)) this.files.delete(uri); }
  pause() {}
  resume() {}
  async flush() { for (const store of this.stores.values()) store.flush(); }
  close() { this.inherited.close(); for (const store of this.stores.values()) store.close(); this.stores.clear(); this.graph.close(); }
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
    volatileProjects: [...this.stores.values()].filter(store => store.path === ':memory:').length,
    cachedFactFiles: [...this.stores.values()].reduce((sum, store) => sum + store.cache.size, 0), factCacheBytes: [...this.stores.values()].reduce((sum, store) => sum + store.cacheBytes, 0) }; }
}

class PersistentGraph {
  constructor(repository) { this.repository = repository; this.keys = new Map(); this.writing = new Map(); this.selected = new Map(); this.volatile = new Map(); }
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
        const key = crypto.createHash('sha256').update('call-graph-3-project-isolation\n' + values.sort().join('\n')).digest('hex'); this.keys.set(project, key);
        const dirty = [...this.repository.overlays.values()].some(file => file.project === project);
        if (dirty && !this.volatile.has(project)) this.volatile.set(project, new IndexDatabase(':memory:', project, this.repository.parserId));
        const store = dirty ? this.volatile.get(project) : this.repository.store(project);
        if (dirty) store.activate(files.filter(file => file.project === project).map(file => file.uri));
        this.selected.set(project, store);
        if (!store.graphReady(key)) {
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
