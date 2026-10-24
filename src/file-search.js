'use strict';
const vscode = require('vscode');
const { excludeReadingEntries } = require('./application/reading-directories');
const { scopeConfigurationChanged } = require('./infrastructure/reading-scope');
const { ViewChannel } = require('./infrastructure/view-channel');
const { RequestGate, globRegex } = require('./core');
const { loadFileIcons } = require('./file-icons');
const { uriKey, relativeUriPath } = require('./resources');

function filterFileTree(roots, query, limit = 2000) {
  const tokens = query.trim().replace(/\\/g, '/').toLowerCase().split(/\s+/)
    .map(token => token.replace(/^\/+|\/+$/g, '')).filter(Boolean);
  if (!tokens.length) return { roots: [], total: 0, files: 0, directories: 0 };
  const namePart = tokens[tokens.length - 1].split('/').pop();
  let total = 0, files = 0, directories = 0;
  const visit = (nodes, parent = '') => nodes.flatMap(node => {
    const path = `${parent}/${node.name}`.toLowerCase();
    // The final term must occur in this node's own name. Matching a parent
    // directory must never pull all unrelated descendants into the result.
    const matched = node.name.toLowerCase().includes(namePart) && tokens.every(token => path.includes(token));
    let keep = false;
    if (matched) {
      total++; if (node.type === 'file') files++; else directories++;
      keep = total <= limit;
    }
    const children = visit(node.children, path);
    return keep || children.length ? [{ ...node, children }] : [];
  });
  const filtered = visit(roots);
  return { roots: filtered, total, files, directories };
}

function fileTree(files) {
  const roots = new Map();
  for (const file of files) {
    const rootKey = file.rootKey || 'workspace', relative = file.relative || file.path;
    if (!roots.has(rootKey)) roots.set(rootKey, { key: rootKey, name: file.rootName || '工程', uri: file.rootUri, type: 'directory', children: new Map(), tooltip: file.rootPath || '' });
    let parent = roots.get(rootKey), path = '';
    const segments = relative.split('/');
    for (let i = 0; i < segments.length; i++) {
      path += '/' + segments[i];
      const key = rootKey + '#' + path;
      if (!parent.children.has(segments[i])) parent.children.set(segments[i], i === segments.length - 1
        ? { ...file, key, type: 'file', tooltip: file.uri.fsPath || file.uri.path, children: new Map() }
        : { key, name: segments[i], uri: file.rootUri ? vscode.Uri.joinPath(file.rootUri, ...segments.slice(0, i + 1)) : undefined, type: 'directory', tooltip: (file.rootPath || '') + path, children: new Map() });
      parent = parent.children.get(segments[i]);
    }
  }
  const finish = node => ({ ...node, children: [...node.children.values()]
    .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name))
    .map(finish) });
  return [...roots.values()].sort((a, b) => a.name.localeCompare(b.name)).map(finish);
}

class FileSearchView {
  constructor(context, catalog, open, fail) {
    this.catalog = catalog; this.context = context; this.open = open; this.fail = fail;
    this.query = context.workspaceState.get('fileSearch.query', ''); this.files = []; this.targets = new Map();
    this.visibleLimit = 3000; this.matchLimit = 2000;
    this.expansion = new Map(context.workspaceState.get('files.expansion', [])); this.filterCollapsed = new Set();
    this.scopeSnapshot = catalog.scope.snapshot();
    this.iconGate = new RequestGate(); this.serial = 0; this.scanGate = new RequestGate(); this.dirty = true; this.disposables = [];
    const changed = () => {
      this.dirty = true; clearTimeout(this.timer);
      if (this.view?.visible) this.timer = setTimeout(() => this.refresh().catch(fail), 250);
    };
    this.disposables.push(this.catalog.onDidChange(event => {
      if (['create', 'delete', 'folders'].includes(event.kind)) changed();
      if (event.kind === 'config') {
        const config = event.configuration;
        if (scopeConfigurationChanged(config)) {
          const previous = this.scopeSnapshot, next = catalog.scope.snapshot();
          const narrowing = !previous.error && !next.error &&
            previous.excludes.every(old => next.excludes.some(root => relativeUriPath(root.uri, old.uri) !== undefined)) &&
            previous.files.every(file => !catalog.scope.contains(file.uri, next));
          const rescan = !this.loaded || this.limited || this.dirty || !narrowing;
          this.scopeSnapshot = next;
          this.scanGate.invalidate(); this.scanCancellation?.cancel(); this.busy = false;
          // Apply exclusions to the current tree before any filesystem work.
          this.files = this.files.filter(file => catalog.contains(file.uri, next));
          const prune = nodes => nodes.flatMap(node => {
            if (node.uri && !catalog.contains(node.uri, next)) return [];
            return [{ ...node, children: prune(node.children) }];
          });
          this.tree = prune(this.tree || []);
          this.error = next.error || '';
          this.publish().catch(fail);
          if (rescan) changed(); else { clearTimeout(this.timer); this.dirty = false; }
          return;
        }
        if (config.affectsConfiguration('workbench.iconTheme') || config.affectsConfiguration('workbench.tree.indent')) this.updateIcons().catch(fail);
        if (config.affectsConfiguration('files.exclude') || config.affectsConfiguration('sourceInsightReader.files')) changed();
      }
    }));
  }
  async updateIcons() {
    if (!this.view || !this.channel || this.disposed) return;
    const request = this.iconGate.next();
    let icons;
    try { icons = await loadFileIcons(this.view.webview); } catch { /* A missing/broken theme uses generic icons. */ }
    if (!this.iconGate.current(request)) return;
    this.icons = icons;
    this.view.webview.options = { enableScripts: true, localResourceRoots: this.channel.roots(icons ? [icons.root] : []) };
    await this.publish();
  }
  resolveWebviewView(view) {
    this.view = view;
    const webview = view.webview;
    this.channel?.dispose();
    this.channel = new ViewChannel(webview, this.context.extensionUri, ['ready', 'search', 'more', 'manageDirectories', 'refresh', 'toggle', 'select', 'open'], message => this.handleMessage(message), this.fail);
    webview.options = { enableScripts: true, localResourceRoots: this.channel.roots() };
    webview.html = this.channel.document({ title: '工程文件', styles: ['media/file-search.css'], scripts: ['media/file-search.js'], images: true, fonts: true, iconStyle: true, body: `
<div class="directory-scope"><button id="manage-directories" title="管理屏蔽的文件和目录">已屏蔽（0）</button></div>
<div class="search"><input id="query" type="search" aria-label="按文件名或目录名包含筛选" autocomplete="off" spellcheck="false"></div>
<div id="results" role="tree" aria-label="工程文件树" aria-multiselectable="true"></div>
<button id="more" type="button" hidden>继续显示结果</button>
` });
    this.closed?.dispose();
    const channel = this.channel;
    this.closed = view.onDidDispose(() => { if (this.channel === channel) { channel.dispose(); this.channel = undefined; this.view = undefined; } });
    this.visibility?.dispose();
    this.visibility = view.onDidChangeVisibility(() => { if (view.visible && this.dirty) this.refresh().catch(this.fail); });
    this.updateIcons().catch(this.fail);
    this.colorSubscription?.dispose();
    if (vscode.window.onDidChangeActiveColorTheme) this.colorSubscription = vscode.window.onDidChangeActiveColorTheme(() => this.updateIcons().catch(this.fail));
    this.refresh().catch(this.fail);
  }
  async refresh() {
    if (!this.view || this.disposed) { this.dirty = true; return; }
    this.scanCancellation?.cancel(); this.scanCancellation?.dispose();
    const cancellation = new vscode.CancellationTokenSource(); this.scanCancellation = cancellation;
    const request = this.scanGate.next(); this.busy = true; this.error = '';
    if (!this.loaded || this.lazyMode && this.query.trim()) await this.publish();
    try {
      if (!this.query.trim() && typeof vscode.workspace.fs.stat === 'function' && typeof vscode.workspace.fs.readDirectory === 'function' &&
        this.catalog.roots().every(root => !Object.values(vscode.workspace.getConfiguration('files', root.uri).get('exclude', {})).some(value => value && typeof value === 'object'))) {
        const roots = this.catalog.roots();
        const trees = await Promise.all(roots.map(async root => {
          const node = { key: uriKey(root.uri), uri: root.uri, name: root.name, type: 'directory', tooltip: root.uri.fsPath || root.uri.path,
            children: [], lazy: true };
          const result = await this.readDirectory(node, root); return { node: { ...node, children: result.nodes, lazy: false }, files: result.files };
        }));
        if (!this.scanGate.current(request)) return;
        this.tree = trees.map(value => value.node); this.files = trees.flatMap(value => value.files); this.lazyMode = true;
        const restore = async nodes => {
          for (const node of nodes) if (node.type === 'directory' && this.expansion.get(node.key)) {
            await this.loadDirectory(node, request); if (!this.scanGate.current(request)) return; await restore(node.children);
          }
        };
        await restore(this.tree);
        if (!this.scanGate.current(request)) return;
        this.loaded = true; this.scopeSnapshot = this.catalog.scope.snapshot(); this.limited = false; this.dirty = false;
        return;
      }
      const uris = await this.catalog.list({ force: true, cancellation: cancellation.token });
      if (!this.scanGate.current(request)) return;
      const roots = [...this.catalog.roots()].sort((a, b) => b.uri.path.length - a.uri.path.length);
      const rules = new Map(roots.map(root => {
        const config = vscode.workspace.getConfiguration('sourceInsightReader', root.uri);
        return [root, { exclude: config.get('files.exclude', []).map(globRegex), include: config.get('files.include', []).map(globRegex) }];
      }));
      this.files = uris.flatMap(uri => {
        const root = roots.find(folder => relativeUriPath(folder.uri, uri) !== undefined); if (!root) return [];
        const relative = relativeUriPath(root.uri, uri), rule = rules.get(root);
        const prefixes = relative.split('/').map((_, i, segments) => segments.slice(0, i + 1).join('/'));
        if (rule.exclude.some(regex => prefixes.some(prefix => regex.test(prefix))) ||
          rule.include.length && !rule.include.some(regex => regex.test(relative))) return [];
        return [{ uri, name: relative.split('/').pop(), path: roots.length > 1 ? `${root.name}/${relative}` : relative,
          relative, rootUri: root.uri, rootKey: uriKey(root.uri), rootName: root.name, rootPath: root.uri.fsPath || root.uri.path }];
      });
      this.tree = fileTree(this.files);
      this.lazyMode = false;
      this.loaded = true; this.scopeSnapshot = this.catalog.scope.snapshot();
      this.limited = false; this.dirty = false;
    } catch (error) {
      if (!this.scanGate.current(request)) return;
      this.error = `文件扫描失败：${error.message}`; this.dirty = true;
    } finally {
      if (this.scanGate.current(request)) { this.busy = false; await this.publish(); }
    }
  }
  async focus() {
    this.focusRequested = true;
    await vscode.commands.executeCommand('sourceInsightReader.files.focus');
    if (this.view) { this.focusRequested = false; await this.channel.postMessage({ focusSearch: true }); }
  }
  async readDirectory(node, root) {
    const entries = await vscode.workspace.fs.readDirectory(node.uri), nodes = [], files = [];
    const config = vscode.workspace.getConfiguration('sourceInsightReader', root.uri);
    const patterns = [...config.get('files.exclude', []), ...Object.entries(vscode.workspace.getConfiguration('files', root.uri).get('exclude', {}))
      .filter(([, value]) => value === true).map(([key]) => key)].map(globRegex);
    const includes = config.get('files.include', []).map(globRegex), snapshot = this.catalog.scope.snapshot();
    for (const [name, type] of entries) {
      const uri = vscode.Uri.joinPath(node.uri, name), relative = relativeUriPath(root.uri, uri);
      const prefixes = relative.split('/').map((_, at, values) => values.slice(0, at + 1).join('/'));
      if (!this.catalog.contains(uri, snapshot) || patterns.some(pattern => prefixes.some(prefix => pattern.test(prefix)))) continue;
      const directory = Boolean(type & vscode.FileType.Directory);
      // Avoid following directory symlink cycles; complete filename search is
      // available through the workspace provider's own enumeration policy.
      if (type & vscode.FileType.SymbolicLink || !directory && !(type & vscode.FileType.File)) continue;
      if (!directory && includes.length && !includes.some(pattern => pattern.test(relative))) continue;
      const entry = { key: uriKey(root.uri) + '#/' + relative, uri, name, type: directory ? 'directory' : 'file',
        tooltip: uri.fsPath || uri.path, children: [], lazy: directory, relative,
        rootKey: uriKey(root.uri), rootUri: root.uri, rootName: root.name, rootPath: root.uri.fsPath || root.uri.path,
        path: this.catalog.roots().length > 1 ? root.name + '/' + relative : relative };
      nodes.push(entry); if (!directory) files.push(entry);
    }
    nodes.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
    return { nodes, files };
  }
  async loadDirectory(node, request = this.scanGate.version) {
    if (!node.lazy) return;
    const root = this.catalog.folder(node.uri); if (!root) return;
    const scope = this.catalog.scopeKey(), result = await this.readDirectory(node, root);
    if (!this.scanGate.current(request) || scope !== this.catalog.scopeKey() || this.disposed) return;
    node.children = result.nodes; node.lazy = false;
    this.files = [...new Map([...this.files, ...result.files].map(file => [uriKey(file.uri), file])).values()];
  }
  findNode(key, nodes = this.tree || []) {
    for (const node of nodes) { if (node.key === key) return node; const found = this.findNode(key, node.children); if (found) return found; }
  }
  async handleMessage(message) {
    if (this.disposed) return;
    if (message.action === 'ready') {
      await this.publish();
      if (this.focusRequested) { this.focusRequested = false; await this.channel?.postMessage({ focusSearch: true }); }
      return;
    }
    if (message.action === 'manageDirectories') return vscode.commands.executeCommand('sourceInsightReader.manageReadingDirectories');
    if (message.action === 'refresh') return this.refresh();
    if (message.action === 'more') { this.visibleLimit += 3000; this.matchLimit += 2000; return this.publish(); }
    if (message.action === 'search' && typeof message.query === 'string') {
      this.visibleLimit = 3000; this.matchLimit = 2000;
      this.query = message.query.slice(0, 500); this.filterCollapsed.clear(); await this.publish();
      if (this.lazyMode && this.query.trim()) await this.refresh();
      await this.context.workspaceState.update('fileSearch.query', this.query); return;
    }
    const file = this.targets.get(message.id); if (!file) return;
    if (message.action === 'toggle' && file.type === 'directory') {
      if (this.query.trim()) {
        if (this.filterCollapsed.has(file.key)) this.filterCollapsed.delete(file.key); else this.filterCollapsed.add(file.key);
      } else {
        this.expansion.set(file.key, !(this.expansion.get(file.key) ?? file.depth === 0));
        if (this.expansion.get(file.key)) {
          const node = this.findNode(file.key); if (node?.lazy) await this.loadDirectory(node);
        }
        await this.context.workspaceState.update('files.expansion', [...this.expansion.entries()]);
      }
      return this.publish();
    }
    if (message.action === 'select' && file.type === 'file') return this.revealFile(file.uri);
    if (message.action !== 'open' || file.type !== 'file') return;
    await this.open({ uri: file.uri, range: new vscode.Range(0, 0, 0, 0), name: file.name });
    await this.revealFile(file.uri);
  }
  async excludeDirectory(context) {
    if (this.disposed || typeof context?.targetId !== 'string' || context.targetIds !== undefined && (typeof context.targetIds !== 'string' || context.targetIds.length > 65536)) return;
    let ids;
    try { ids = context.targetIds ? JSON.parse(context.targetIds) : [context.targetId]; } catch { return; }
    if (!Array.isArray(ids) || !ids.length || ids.length > 3000 || !ids.includes(context.targetId) || ids.some(id => typeof id !== 'string' || !this.targets.has(id))) return;
    const entries = [...new Set(ids)].map(id => this.targets.get(id));
    if (entries.some(entry => !entry.uri || !['file', 'directory'].includes(entry.type))) return;
    await excludeReadingEntries(this.catalog, entries);
  }
  async revealFile(uri) {
    this.selectedUri = uri;
    if (this.lazyMode) {
      const root = [...(this.tree || [])].sort((a, b) => b.uri.path.length - a.uri.path.length).find(node => relativeUriPath(node.uri, uri) !== undefined);
      if (root) {
        let node = root;
        for (const part of relativeUriPath(root.uri, uri).split('/').slice(0, -1)) {
          await this.loadDirectory(node); this.expansion.set(node.key, true);
          const next = node.children.find(child => child.name === part && child.type === 'directory'); if (!next) break;
          node = next;
        }
        await this.loadDirectory(node); this.expansion.set(node.key, true);
      }
    }
    const visit = (nodes, parents) => {
      for (const node of nodes) {
        if (node.type === 'file' && uriKey(node.uri) === uriKey(uri)) {
          for (const parent of parents) { this.expansion.set(parent, true); this.filterCollapsed.delete(parent); }
          return true;
        }
        if (node.children.length && visit(node.children, [...parents, node.key])) return true;
      }
      return false;
    };
    visit(this.tree || [], []); await this.publish(true);
  }
  async publish(reveal = false) {
    if (!this.view || !this.channel || this.disposed) return;
    const filtering = Boolean(this.query.trim());
    const matches = filtering ? filterFileTree(this.tree || [], this.query, this.matchLimit) : { roots: this.tree || [], total: this.files.length, files: this.files.length, directories: 0 };
    const roots = matches.roots;
    this.targets.clear();
    const rows = []; let visible = 0;
    const walk = (nodes, depth) => {
      for (const node of nodes) {
        const expanded = filtering ? !this.filterCollapsed.has(node.key) : this.expansion.get(node.key) ?? depth === 0;
        visible++;
        if (rows.length < this.visibleLimit) {
          const id = String(++this.serial); this.targets.set(id, { ...node, depth });
          rows.push({ id, key: node.key, type: node.type, depth, name: node.name, tooltip: node.tooltip,
            expanded, icon: this.icons?.iconFor(node.name, node.type, expanded, depth === 0), selected: node.type === 'file' && this.selectedUri && uriKey(node.uri) === uriKey(this.selectedUri) });
        }
        if (expanded && node.children.length) walk(node.children, depth + 1);
      }
    };
    walk(roots, 0);
    await this.channel.postMessage({ excludedCount: this.catalog.scope.settings('excludedDirectories').length + this.catalog.scope.settings('excludedFiles').length, query: this.query, rows, reveal,
      hasMore: visible > this.visibleLimit || filtering && matches.total > this.matchLimit, iconCss: this.icons?.css || '', nativeIcons: Boolean(this.icons),
      indent: Math.max(4, Math.min(40, vscode.workspace.getConfiguration('workbench').get('tree.indent', 8))),
      status: this.error || (this.busy ? '正在扫描文件…' : !vscode.workspace.workspaceFolders?.length ? '请先打开文件夹或工作区'
        : `${this.lazyMode && !filtering ? '按需加载目录 · 已加载 ' : ''}${matches.files} 个文件${filtering ? `、${matches.directories} 个目录匹配` : ''}${matches.total > this.matchLimit && filtering ? `，已筛选前 ${this.matchLimit} 项，可继续显示` : ''}${visible > this.visibleLimit ? `，已显示 ${this.visibleLimit} 个树节点，可继续显示` : ''}`) });
  }
  dispose() {
    this.disposed = true; this.channel?.dispose(); this.closed?.dispose(); clearTimeout(this.timer); this.scanGate.dispose(); this.iconGate.dispose();
    this.scanCancellation?.cancel(); this.scanCancellation?.dispose();
    this.visibility?.dispose(); this.colorSubscription?.dispose(); this.disposables.forEach(item => item.dispose()); this.targets.clear();
  }
}
module.exports = { FileSearchView, filterFileTree, fileTree };
