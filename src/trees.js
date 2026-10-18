'use strict';
const vscode = require('vscode');
const { RequestGate, filterSymbols, locationKey, normalizeCalls, globRegex } = require('./core');
const { uriKey, sameUri, relativeUriPath } = require('./resources');
const S = vscode.TreeItemCollapsibleState;
const symbolIcons = { 0: 'file-code', 1: 'symbol-module', 2: 'symbol-namespace', 3: 'symbol-package',
  4: 'symbol-class', 5: 'symbol-method', 6: 'symbol-property', 7: 'symbol-field', 8: 'symbol-method',
  9: 'symbol-enum', 10: 'symbol-interface', 11: 'symbol-method', 12: 'symbol-variable', 13: 'symbol-constant',
  14: 'symbol-string', 15: 'symbol-numeric', 16: 'symbol-boolean', 17: 'symbol-array', 18: 'symbol-object',
  19: 'symbol-key', 20: 'symbol-null', 21: 'symbol-enum-member', 22: 'symbol-struct', 23: 'symbol-event',
  24: 'symbol-operator', 25: 'symbol-type-parameter' };

function message(label) { return { type: 'message', label }; }
function target(node) {
  return { uri: node.uri, range: node.selectionRange || node.range, name: node.name };
}
function errorText(error) { return error instanceof Error ? error.message : String(error); }
function emptyText(noun) { return `无${noun}结果（服务可能未就绪或不支持，请配置语言服务后刷新）`; }

class BaseTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.gate = new RequestGate();
    this.message = '请选择主编辑器中的符号';
  }
  refresh(node) { this.emitter.fire(node); }
  dispose() { this.gate.dispose(); this.emitter.dispose(); }
  getTreeItem(node) {
    if (node.type === 'message') return new vscode.TreeItem(node.label, S.None);
    throw new Error(`Unknown tree node: ${node.type}`);
  }
}

class FileTree extends BaseTree {
  constructor() { super(); }
  getParent(node) { return node.parent; }
  /** @returns {Promise<Array<{type: string, uri?: import('vscode').Uri, root?: import('vscode').Uri, name?: string, label?: string, parent?: any}>>} */
  async getChildren(node) {
    if (!node) {
      const roots = (vscode.workspace.workspaceFolders || []).map(folder => ({
        type: 'folder', uri: folder.uri, root: folder.uri, name: folder.name
      }));
      return roots.length ? roots : [message('打开文件夹以浏览工程')];
    }
    if (node.type !== 'folder') return [];
    try {
      const config = vscode.workspace.getConfiguration('sourceReader', node.uri);
      const excludes = [
        ...Object.entries(vscode.workspace.getConfiguration('files', node.uri).get('exclude', {}))
          .filter(([, value]) => value === true).map(([key]) => key),
        ...config.get('files.exclude', [])
      ].map(globRegex);
      const includes = config.get('files.include', []).map(globRegex);
      const entries = await vscode.workspace.fs.readDirectory(node.uri);
      return entries.flatMap(([name, kind]) => {
        const uri = vscode.Uri.joinPath(node.uri, name);
        const relative = relativeUriPath(node.root, uri);
        if (relative === undefined) return [];
        if (excludes.some(regex => regex.test(relative))) return [];
        // Do not recursively follow symlinks; avoids cycles/outside-workspace traversal.
        if (kind & vscode.FileType.SymbolicLink) return [];
        const folder = Boolean(kind & vscode.FileType.Directory);
        if (!folder && includes.length && !includes.some(regex => regex.test(relative))) return [];
        return [{ type: folder ? 'folder' : 'file', uri, name, root: node.root, parent: node }];
      }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
    } catch (error) { return [message(`读取目录失败：${errorText(error)}`)]; }
  }
  getTreeItem(node) {
    if (node.type === 'message') return super.getTreeItem(node);
    const item = new vscode.TreeItem(node.name, node.type === 'folder' ? S.Collapsed : S.None);
    item.resourceUri = node.uri;
    item.iconPath = new vscode.ThemeIcon(node.type === 'folder' ? 'folder' : 'file');
    item.contextValue = `sourceReader.${node.type}`;
    item.id = uriKey(node.uri);
    if (node.type === 'file') item.command = { command: 'sourceReader.openTarget', title: '打开', arguments: [node] };
    return item;
  }
  async find(uri) {
    let node = (await this.getChildren()).filter(root => root.uri && relativeUriPath(root.uri, uri) !== undefined)
      .sort((a, b) => b.uri.path.length - a.uri.path.length)[0];
    if (!node) return;
    while (!sameUri(node.uri, uri)) {
      const children = await this.getChildren(node);
      const next = children.find(child => child.uri && relativeUriPath(child.uri, uri) !== undefined);
      if (!next) return;
      node = next;
    }
    return node;
  }
}

class SymbolTree extends BaseTree {
  constructor(language) { super(); this.language = language; this.nodes = []; this.query = ''; this.sort = 'position'; this.allSymbols = false; this.selectionEpoch = 0; this.rebuild(); }
  clearSelection() { this.selectionEpoch++; this.refresh(); }
  rebuild() { this.displayed = filterSymbols(this.nodes, this.query, this.sort, undefined, this.allSymbols); }
  refresh(node) { this.rebuild(); super.refresh(node); }
  invalidate() { this.gate.invalidate(); }
  async load(uri) {
    const request = this.gate.next();
    this.uri = uri;
    this.nodes = [];
    this.message = '正在查询文件符号…'; this.refresh();
    try {
      const nodes = await this.language.symbols(uri);
      if (!this.gate.current(request)) return false;
      this.nodes = nodes;
      this.message = emptyText('函数');
    } catch (error) {
      if (!this.gate.current(request)) return false;
      this.message = `查询失败：${errorText(error)}`;
    }
    this.refresh();
    return true;
  }
  getChildren(node) {
    const nodes = node ? node.children || [] : this.displayed;
    return nodes.length || node ? nodes : [message(this.query ? '无匹配函数' : this.message)];
  }
  getParent(node) { return node.parent; }
  findDisplayed(key, nodes = this.displayed || []) {
    for (const node of nodes) {
      if (locationKey(target(node)) === key) return node;
      const nested = this.findDisplayed(key, node.children);
      if (nested) return nested;
    }
  }
  getTreeItem(node) {
    if (node.type === 'message') return super.getTreeItem(node);
    const item = new vscode.TreeItem(node.name, node.children.length ? S.Expanded : S.None);
    item.description = node.detail;
    item.tooltip = `${node.name}\n${vscode.workspace.asRelativePath(node.uri)}:${node.selectionRange.start.line + 1}`;
    item.id = `${this.selectionEpoch}:${locationKey(target(node))}`;
    item.iconPath = new vscode.ThemeIcon(symbolIcons[node.kind] || 'symbol-method');
    item.contextValue = 'sourceReader.symbol';
    item.command = { command: 'sourceReader.openTarget', title: '定位函数', arguments: [node] };
    return item;
  }
}

class RelationTree extends BaseTree {
  constructor(language, changed = description => {}) {
    super(); this.language = language; this.changed = changed;
    this.direction = 'incoming'; this.locked = false; this.root = undefined; this.stale = false;
    this.callsCache = new Map();
  }
  switchDirection(direction) {
    this.direction = direction; this.gate.invalidate(); this.callsCache.clear(); this.updateLabel(); this.refresh();
  }
  invalidate() { this.gate.invalidate(); this.refresh(); }
  updateLabel() { this.changed(`${this.locked ? '🔒 ' : ''}${this.direction === 'incoming' ? '谁调用它' : '它调用谁'}${this.stale ? ' · 可能过期' : ''}`); }
  async setRoot(source, force = false) {
    if (this.locked && (!force || !this.source || locationKey(source) !== locationKey(this.source))) return;
    const request = this.gate.next();
    this.callsCache.clear();
    this.source = source; this.root = undefined; this.stale = false;
    this.message = '正在查询调用层次…'; this.updateLabel(); this.refresh();
    try {
      const roots = await this.language.prepare(source.uri, source.range.start);
      if (!this.gate.current(request)) return;
      let item = roots[0];
      if (roots.length > 1) {
        if (!force) {
          this.message = '有多个调用根候选，请显式“设为 Relation 根节点”选择';
          this.refresh(); return;
        }
        /** @type {Array<import('vscode').QuickPickItem & {item: import('vscode').CallHierarchyItem}>} */
        const choices = roots.map(root => ({
          label: root.name, description: vscode.workspace.asRelativePath(root.uri), item: root
        }));
        const choice = await vscode.window.showQuickPick(choices, { placeHolder: '选择调用关系根节点' });
        if (!this.gate.current(request)) return;
        item = choice?.item;
      }
      if (item) this.root = {
        type: 'relation', item, uri: item.uri, range: item.selectionRange, name: item.name,
        sites: [], ancestors: [locationKey({ uri: item.uri, range: item.selectionRange })], cycle: false
      };
      this.message = emptyText('调用层次');
    } catch (error) {
      if (!this.gate.current(request)) return;
      this.message = `查询失败：${errorText(error)}`;
    }
    this.refresh();
  }
  markStale() {
    if (!this.source) return;
    this.gate.invalidate(); this.callsCache.clear(); this.stale = true;
    this.message = this.root ? this.message : '源码已修改，请刷新调用关系';
    this.updateLabel(); this.refresh();
  }
  async getChildren(node) {
    if (!node) return this.root ? [this.root] : [message(this.message)];
    if (node.type === 'sites') return node.sites.map((site, index) => ({
      type: 'callsite', ...site, name: `调用位置 ${index + 1} · ${site.range.start.line + 1}:${site.range.start.character + 1}`
    }));
    if (node.type !== 'relation') return [];
    const sites = node.sites.length ? [{ type: 'sites', sites: node.sites }] : [];
    if (node.cycle) return [...sites, message('↻ 递归关系：停止沿此路径展开')];
    if (this.stale) return [...sites, message('源码已修改，请刷新关系根节点')];
    const version = this.gate.version;
    const direction = this.direction;
    try {
      const key = `${direction}:${locationKey({ uri: node.item.uri, range: node.item.selectionRange })}`;
      if (!this.callsCache.has(key)) {
        const request = this.language.calls(node.item, direction);
        this.callsCache.set(key, request);
        request.catch(() => { if (this.callsCache.get(key) === request) this.callsCache.delete(key); });
      }
      const calls = await this.callsCache.get(key);
      if (!this.gate.current(version)) return [];
      const children = normalizeCalls(node.item, calls, direction, node.ancestors);
      const empty = direction === 'outgoing' ? '未返回被调用函数；若使用 clangd，此方向需要 20 或更高版本' : emptyText('调用');
      return [...sites, ...(children.length ? children : [message(empty)])];
    } catch (error) { return this.gate.current(version) ? [...sites, message(`查询失败：${errorText(error)}`)] : []; }
  }
  getTreeItem(node) {
    if (node.type === 'message') return super.getTreeItem(node);
    if (node.type === 'sites') return new vscode.TreeItem(`调用位置（${node.sites.length}）`, S.Collapsed);
    if (node.type === 'callsite') {
      const item = new vscode.TreeItem(node.name, S.None);
      item.contextValue = 'sourceReader.callsite';
      item.command = { command: 'sourceReader.selectTarget', title: '预览调用现场', arguments: [node] };
      return item;
    }
    const item = new vscode.TreeItem(`${node.cycle ? '↻ ' : ''}${node.name}`, S.Collapsed);
    item.description = vscode.workspace.asRelativePath(node.uri);
    item.contextValue = 'sourceReader.relation';
    item.iconPath = new vscode.ThemeIcon('symbol-method');
    item.command = { command: 'sourceReader.selectTarget', title: '预览定义', arguments: [node] };
    return item;
  }
}

class ReferencesTree extends BaseTree {
  constructor(language, changed = description => {}) {
    super(); this.language = language; this.changed = changed;
    this.groups = []; this.visibleGroups = []; this.query = ''; this.stale = false;
    this.recentSources = []; this.filterGate = new RequestGate();
    this.message = '执行 Lookup References 查询符号引用';
  }
  updateLabel() {
    const total = this.groups.reduce((sum, group) => sum + group.children.length, 0);
    const visible = this.visibleGroups.reduce((sum, group) => sum + group.children.length, 0);
    const count = this.query ? `${visible}/${total}` : `${total}`;
    this.changed(this.source ? `${this.source.name || '符号'} · ${count} 个引用${this.stale ? ' · 可能过期，请刷新' : ''}` : '');
  }
  async lookup(source) {
    const request = this.gate.next(); this.filterGate.invalidate();
    this.recentSources = [source, ...this.recentSources.filter(previous => locationKey(previous) !== locationKey(source))].slice(0, 20);
    this.source = source; this.groups = []; this.visibleGroups = []; this.stale = false;
    this.message = '正在查询引用…'; this.changed(source.name || vscode.workspace.asRelativePath(source.uri)); this.refresh();
    try {
      const locations = await this.language.references(source.uri, source.range.start);
      if (!this.gate.current(request)) return;
      const groups = new Map();
      for (const location of locations) {
        const key = uriKey(location.uri);
        if (!groups.has(key)) groups.set(key, { type: 'referenceFile', uri: location.uri, children: [], shown: 200 });
        groups.get(key).children.push({ type: 'reference', ...location });
      }
      this.groups = [...groups.values()].sort((a, b) => uriKey(a.uri).localeCompare(uriKey(b.uri)));
      for (const group of this.groups) group.children.sort((a, b) =>
        a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
      await this.filter(this.query);
      if (!this.gate.current(request)) return;
    } catch (error) {
      if (!this.gate.current(request)) return;
      this.message = `查询失败：${errorText(error)}`;
    }
    this.refresh();
  }
  async filter(query) {
    this.query = query.trim();
    const request = this.filterGate.next();
    const session = this.gate.version;
    const needle = this.query.toLowerCase();
    if (!needle) this.visibleGroups = this.groups;
    else {
      this.message = '正在筛选引用…'; this.refresh();
      const filtered = [];
      for (const group of this.groups) {
        if (!this.filterGate.current(request) || !this.gate.current(session)) return;
        if (vscode.workspace.asRelativePath(group.uri).toLowerCase().includes(needle)) {
          filtered.push({ ...group, shown: 200 }); continue;
        }
        try {
          const document = await vscode.workspace.openTextDocument(group.uri);
          if (!this.filterGate.current(request) || !this.gate.current(session)) return;
          const children = group.children.filter(child => child.range.start.line < document.lineCount &&
            document.lineAt(child.range.start.line).text.toLowerCase().includes(needle));
          if (children.length) filtered.push({ ...group, children, shown: 200 });
        } catch { /* Unavailable files remain visible when matched by path. */ }
      }
      this.visibleGroups = filtered;
    }
    this.message = needle ? '没有匹配的引用（按文件路径或源码筛选）' : emptyText('引用');
    this.updateLabel(); this.refresh();
  }
  markStale() {
    if (!this.source) return;
    this.gate.invalidate(); this.filterGate.invalidate(); this.stale = true;
    this.message = '源码已修改，请刷新引用';
    this.updateLabel(); this.refresh();
  }
  clear() {
    this.gate.invalidate(); this.filterGate.invalidate(); this.source = undefined;
    this.groups = []; this.visibleGroups = []; this.query = ''; this.stale = false;
    this.message = '执行 Lookup References 查询符号引用'; this.changed(''); this.refresh();
  }
  async getChildren(node) {
    if (!node) return this.visibleGroups.length ? this.visibleGroups : [message(this.message)];
    if (node.type !== 'referenceFile') return [];
    const session = this.gate.version;
    const result = node.children.slice(0, node.shown);
    for (const child of result) child.parent = node;
    try {
      const document = await vscode.workspace.openTextDocument(node.uri);
      for (const child of result) {
        if (child.range.start.line >= document.lineCount) { child.snippet = '位置可能过期，请刷新'; continue; }
        const line = document.lineAt(child.range.start.line).text.trim();
        const match = this.query ? line.toLowerCase().indexOf(this.query.toLowerCase()) : -1;
        const start = match > 120 ? match - 60 : 0;
        child.snippet = `${start ? '…' : ''}${line.slice(start, start + 180)}`;
      }
    } catch { for (const child of result) child.snippet = '文件不可用，请刷新'; }
    if (!this.gate.current(session)) return [];
    return node.children.length > node.shown
      ? [...result, { type: 'more', group: node, label: `显示更多（已展示 ${node.shown}/${node.children.length}）` }]
      : result;
  }
  allVisibleReferences() { return this.visibleGroups.flatMap(group => group.children); }
  getParent(node) { return node.parent; }
  getTreeItem(node) {
    if (node.type === 'message') return super.getTreeItem(node);
    if (node.type === 'more') {
      const item = new vscode.TreeItem(node.label, S.None);
      item.command = { command: 'sourceReader.moreReferences', title: '显示更多', arguments: [node.group] };
      return item;
    }
    if (node.type === 'referenceFile') {
      const item = new vscode.TreeItem(vscode.workspace.asRelativePath(node.uri), S.Collapsed);
      item.description = `${node.children.length}`; item.resourceUri = node.uri; return item;
    }
    const item = new vscode.TreeItem(`${node.range.start.line + 1}:${node.range.start.character + 1}`, S.None);
    item.description = node.snippet; item.contextValue = 'sourceReader.reference';
    item.command = { command: 'sourceReader.selectTarget', title: '预览引用现场', arguments: [node] }; return item;
  }
  async resolveTreeItem(item, node) {
    if (node.type !== 'reference') return item;
    try {
      const document = await vscode.workspace.openTextDocument(node.uri);
      const line = document.lineAt(Math.min(node.range.start.line, document.lineCount - 1)).text.trim();
      item.tooltip = `${vscode.workspace.asRelativePath(node.uri)}:${node.range.start.line + 1}\n${line}`;
    } catch { item.tooltip = '文件不可用，请刷新引用'; }
    return item;
  }
  dispose() { this.filterGate.dispose(); super.dispose(); }
}

module.exports = { FileTree, SymbolTree, RelationTree, ReferencesTree, target, errorText };
