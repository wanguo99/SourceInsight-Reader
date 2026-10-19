'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const { Observable } = require('../domain/observable');
const { uriKey } = require('../resources');
const { enclosingFunction } = require('../core');
const { referenceSnippet } = require('./result-snippet');
const PAGE_SIZE = 300;
class SearchSession {
  constructor(model, open, preview) {
    this.model = model; this.open = open; this.preview = preview; this.page = 0; this.selected = -1; this.targets = new Map(); this.ids = new WeakMap(); this.serial = 0;
    this.subscription = undefined; this.seenGeneration = model.gate.version;
    this.events = new Observable(); this.onDidChange = listener => this.events.subscribe(listener);
  }
  changed() {
    if (this.seenGeneration !== this.generation) { this.seenGeneration = this.generation; this.page = 0; this.selected = -1; this.targets.clear(); this.reset(); }
    this.events.emit();
  }
  reset() {}
  async validate(row) { return false; }
  get generation() { return this.model.gate.version; }
  get selection() { const row = this.rows()[this.selected]; return row ? [row] : []; }
  get stale() { return Boolean(this.model.stale); }
  rows() { return []; }
  async navigate(row, action = 'open') {
    const generation = this.generation;
    if (this.stale || this.model.busy || !await this.validate(row) || generation !== this.generation || !this.rows().includes(row)) return;
    this.selected = this.rows().indexOf(row); this.page = Math.floor(this.selected / PAGE_SIZE);
    if (action === 'preview') await this.preview({ type: 'reference', ...row }); else await this.open(row, action === 'pin');
    this.changed();
  }
  async move(direction) {
    const rows = this.rows(); if (!rows.length || this.stale || this.model.busy) return;
    const index = this.selected < 0 ? direction > 0 ? 0 : rows.length - 1 : (this.selected + direction + rows.length) % rows.length;
    return this.navigate(rows[index]);
  }
  async handle(message) {
    if (message.action === 'next' || message.action === 'previous') return this.move(message.action === 'next' ? 1 : -1);
    if (message.action === 'pageNext' || message.action === 'pagePrevious') {
      this.page = Math.max(0, Math.min(Math.ceil(this.rows().length / PAGE_SIZE) - 1, this.page + (message.action === 'pageNext' ? 1 : -1))); this.changed(); return;
    }
    if (['open', 'preview', 'pin'].includes(message.action)) {
      if (message.generation !== this.generation) return;
      const row = this.targets.get(message.id); if (row) await this.navigate(row, message.action);
    }
  }
  pageRows() {
    const rows = this.rows(), pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    this.page = Math.max(0, Math.min(this.page, pages - 1));
    this.targets.clear();
    return { values: rows.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE), pages, total: rows.length };
  }
  id(row) { if (!this.ids.has(row)) this.ids.set(row, String(++this.serial)); const id = this.ids.get(row); this.targets.set(id, row); return id; }
  dispose() { this.subscription?.dispose(); this.events.dispose(); this.targets.clear(); }
}
class TextSearchSession extends SearchSession {
  constructor(model, catalog, open, preview) {
    super(model, open, preview); this.catalog = catalog;
    this.subscription = model.onDidChange(() => this.changed());
  }
  rows() { return this.model.rows; }
  validate(row) { return this.model.validate(row); }
  async launch(query, uri) {
    this.page = 0; this.selected = -1;
    const roots = this.catalog.roots(), folder = uri && this.catalog.folder(uri) || roots.find(root => root.uri.toString() === this.model.folder?.uri.toString()) || roots[0];
    await this.model.search(query, folder);
  }
  async handle(message) {
    if (message.action === 'search') {
      this.page = 0; this.selected = -1;
      const folder = this.catalog.roots().find(value => value.uri.toString() === message.folder);
      return this.model.search(message.query, folder, message);
    }
    if (message.action === 'refresh') { this.page = 0; return this.model.search(this.model.query || '', this.model.folder); }
    if (message.action === 'cancel') { this.model.markStale(); this.model.message = '检索已取消'; this.model.changed(); return; }
    if (message.action === 'clear') { this.selected = -1; return this.model.clear(); }
    if (message.action === 'history' && message.id) {
      const item = this.model.history.find(value => value.id === message.id); if (!item) return;
      this.page = 0; this.selected = -1;
      return this.model.search(item.query, this.catalog.roots().find(root => root.uri.toString() === item.folder), item);
    }
    return super.handle(message);
  }
  async snapshot() {
    const model = this.model, page = this.pageRows();
    for (const item of model.history) item.id ||= crypto.randomBytes(6).toString('hex');
    return { mode: 'text', query: model.query || '', generation: this.generation, ...model.options,
      folder: model.folder?.uri.toString(), folders: this.catalog.roots().map(root => ({ id: root.uri.toString(), name: root.name })),
      rows: page.values.map(row => ({ id: this.id(row), owner: row.owner, path: row.path, line: row.line + 1, column: row.start + 1,
        before: row.before, matched: row.matched, after: row.after, selected: this.rows()[this.selected] === row })),
      history: model.history.map(item => ({ ...item })), page: this.page + 1, pages: page.pages, total: page.total,
      busy: Boolean(model.busy), stale: this.stale, status: model.message, selected: this.selected < 0 ? '' : `${this.selected + 1} / ${page.total}` };
  }
}
class ReferenceSearchSession extends SearchSession {
  constructor(model, open, preview, history, symbols = async uri => []) {
    super(model, open, preview); this.history = history; this.symbols = symbols; this.documents = new Map(); this.versions = new Map(); this.snapshotSequence = 0;
    this.subscription = model.onDidChangeTreeData(() => this.changed());
  }
  reset() { this.versions.clear(); this.documents.clear(); this.snapshotSequence++; }
  rows() { return this.model.allVisibleReferences(); }
  async validate(row) {
    const generation = this.generation, document = await vscode.workspace.openTextDocument(row.uri);
    if (this.stale || generation !== this.generation || !this.rows().includes(row)) return false;
    const version = this.versions.get(uriKey(row.uri));
    if (version !== undefined && version !== document.version || row.range.start.line >= document.lineCount) { this.model.markStale(); return false; }
    return true;
  }
  async handle(message) {
    if (message.action === 'search') { this.page = 0; this.selected = -1; return this.model.filter(message.query); }
    if (message.action === 'refresh' && this.model.source) { this.versions.clear(); return this.model.lookup(this.model.source); }
    if (message.action === 'clear') { this.versions.clear(); this.selected = -1; return this.model.clear(); }
    if (message.action === 'history') return this.history();
    return super.handle(message);
  }
  async snapshot() {
    const request = ++this.snapshotSequence, generation = this.generation, page = this.pageRows(), rows = [];
    const current = () => generation === this.generation && request === this.snapshotSequence;
    const documents = new Map();
    const uris = [...new Map(page.values.map(row => [uriKey(row.uri), row.uri])).values()];
    let cursor = 0; const deadline = Date.now() + 1500;
    // Open each document and collect its function ranges once, with bounded
    // concurrency. Cache only this page so large searches cannot retain all files.
    await Promise.all(Array.from({ length: Math.min(4, uris.length) }, async () => {
      while (cursor < uris.length && current()) {
        const uri = uris[cursor++], key = uriKey(uri);
        try {
          const document = await vscode.workspace.openTextDocument(uri);
          if (!current()) return;
          const cached = this.documents.get(key);
          let timer;
          const version = document.version;
          let nodes;
          try {
            nodes = cached?.version === version ? cached.nodes : Date.now() >= deadline ? [] : await Promise.race([
              this.symbols(uri).catch(() => []),
              new Promise(resolve => { timer = setTimeout(() => resolve([]), Math.max(1, deadline - Date.now())); })
            ]);
          } finally { clearTimeout(timer); }
          if (document.version !== version) { this.model.markStale(); return; }
          if (!current()) return;
          const entry = { document, version: document.version, nodes };
          documents.set(key, entry);
          const oldVersion = this.versions.get(key);
          if (oldVersion !== undefined && oldVersion !== document.version) this.model.markStale();
          else this.versions.set(key, document.version);
        } catch { /* An unavailable file remains visible without a jump target. */ }
      }
    }));
    if (!current()) return undefined;
    this.documents = documents;
    for (const row of page.values) {
      const entry = documents.get(uriKey(row.uri));
      const valid = entry && row.range.start.line < entry.document.lineCount;
      const snippet = valid ? referenceSnippet(entry.document.lineAt(row.range.start.line).text, row.range)
        : { before: entry ? '位置可能过期，请刷新' : '文件不可用', matched: '', after: '' };
      const owner = entry && enclosingFunction(entry.nodes, row.range.start)?.name;
      rows.push({ id: this.id(row), owner: owner || (entry?.nodes.length ? '文件作用域' : '引用'), path: vscode.workspace.asRelativePath(row.uri), line: row.range.start.line + 1,
        column: row.range.start.character + 1, ...snippet, selected: this.rows()[this.selected] === row });
    }
    return { mode: 'references', generation, query: this.model.query, rows, history: [], folders: [], page: this.page + 1, pages: page.pages,
      total: page.total, busy: Boolean(this.model.busy), stale: this.stale,
      status: `${this.model.source?.name || 'Lookup References'} · ${page.total} 个引用${this.stale ? ' · 源码已修改，请刷新' : !page.total ? ` · ${this.model.message}` : ''}`,
      selected: this.selected < 0 ? '' : `${this.selected + 1} / ${page.total}` };
  }
}
module.exports = { TextSearchSession, ReferenceSearchSession };
