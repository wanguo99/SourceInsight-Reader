'use strict';
const vscode = require('vscode');
const queryState = require('./domain/query-state');
const { queryResult } = require('./domain/model');
const { RequestGate, filterSymbols, locationKey } = require('./core');
const { uriKey, sameUri } = require('./resources');
const { symbolCategory } = require('./document-symbols');
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

class SymbolTree extends BaseTree {
  constructor(language) { super(); this.language = language; this.nodes = []; this.query = ''; this.sort = 'position'; this.allSymbols = true; this.selectionEpoch = 0; this.rebuild(); }
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
      this.message = emptyText('文件符号');
    } catch (error) {
      if (!this.gate.current(request)) return false;
      this.message = `查询失败：${errorText(error)}`;
    }
    this.refresh();
    return true;
  }
  getChildren(node) {
    const nodes = node ? node.children || [] : this.displayed;
    return nodes.length || node ? nodes : [message(this.query ? '无匹配符号' : !this.allSymbols && this.nodes.length
      ? '没有匹配函数，可切换为“全部符号”查看头文件、宏和变量等' : this.message)];
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
    const category = symbolCategory(node);
    item.description = node.detail ? `${category} · ${node.detail}` : category;
    item.tooltip = `${category}：${node.name}\n${vscode.workspace.asRelativePath(node.uri)}:${node.selectionRange.start.line + 1}` +
      (node.origin === 'source' ? '\n源码条目，未判断条件编译是否生效' : node.origin === 'local'
        ? '\n本地 C 语法索引，未判断条件编译是否生效' : '') + (node.detail ? `\n${node.detail}` : '');
    item.id = `${this.selectionEpoch}:${locationKey(target(node))}`;
    item.iconPath = new vscode.ThemeIcon(symbolIcons[node.kind] || 'symbol-method');
    item.contextValue = 'sourceInsightInspired.symbol';
    item.command = { command: 'sourceInsightInspired.openTarget', title: '定位符号', arguments: [node] };
    return item;
  }
}

class ReferencesTree extends BaseTree {
  constructor(language, changed = description => {}) {
    super(); this.language = language; this.changed = changed;
    this.groups = []; this.visibleGroups = []; this.query = ''; this.queryState = queryState.idle();
    this.recentSources = []; this.filterGate = new RequestGate();
    this.message = '执行 Lookup References 查询符号引用';
  }
  get busy() { return ['loading', 'refreshing'].includes(this.queryState.status); }
  get stale() { return this.queryState.status === 'stale'; }
  updateLabel() {
    const total = this.groups.reduce((sum, group) => sum + group.children.length, 0);
    const visible = this.visibleGroups.reduce((sum, group) => sum + group.children.length, 0);
    const count = this.query ? `${visible}/${total}` : `${total}`;
    this.changed(this.source ? `${this.source.name || '符号'} · ${count} 个引用${this.stale ? ' · 可能过期，请刷新' : ''}` : '');
  }
  async lookup(source) {
    const request = this.gate.next(); this.filterGate.invalidate();
    this.recentSources = [source, ...this.recentSources.filter(previous => locationKey(previous) !== locationKey(source))].slice(0, 20);
    this.source = source; this.groups = []; this.visibleGroups = []; this.queryState = queryState.begin(queryState.idle(), request, String(request));
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
      this.queryState = queryState.settle(this.queryState, queryResult(this.groups, 'languageService', this.groups.length ? 'ready' : 'empty', String(request)));
    } catch (error) {
      if (!this.gate.current(request)) return;
      this.queryState = queryState.settle(this.queryState, queryResult([], 'languageService', 'error', String(request), [errorText(error)]));
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
    this.gate.invalidate(); this.filterGate.invalidate(); this.queryState = queryState.stale(this.queryState, this.gate.version);
    this.message = '源码已修改，请刷新引用';
    this.updateLabel(); this.refresh();
  }
  clear() {
    this.gate.invalidate(); this.filterGate.invalidate(); this.source = undefined;
    this.groups = []; this.visibleGroups = []; this.query = ''; this.queryState = queryState.idle();
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
      item.command = { command: 'sourceInsightInspired.moreReferences', title: '显示更多', arguments: [node.group] };
      return item;
    }
    if (node.type === 'referenceFile') {
      const item = new vscode.TreeItem(vscode.workspace.asRelativePath(node.uri), S.Collapsed);
      item.description = `${node.children.length}`; item.resourceUri = node.uri; return item;
    }
    const item = new vscode.TreeItem(`${node.range.start.line + 1}:${node.range.start.character + 1}`, S.None);
    item.description = node.snippet; item.contextValue = 'sourceInsightInspired.reference';
    item.command = { command: 'sourceInsightInspired.selectTarget', title: '预览引用现场', arguments: [node] }; return item;
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

module.exports = { SymbolTree, ReferencesTree, target, errorText };
