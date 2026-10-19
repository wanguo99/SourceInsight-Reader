'use strict';
const vscode = require('vscode');
const { ViewChannel } = require('./infrastructure/view-channel');
const { locationKey } = require('./core');
const { target } = require('./trees');
const { symbolCategory } = require('./document-symbols');
const { symbolIcon } = require('./symbol-icons');

class SymbolView {
  constructor(extensionUri, model, open, filter, fail) {
    this.extensionUri = extensionUri; this.model = model; this.open = open; this.filter = filter; this.fail = fail;
    this.title = '文件符号'; this.message = ''; this.description = '';
    this.selection = []; this.targets = new Map(); this.collapsed = new Set(); this.serial = 0;
    this.selectionEmitter = new vscode.EventEmitter(); this.onDidChangeSelection = this.selectionEmitter.event;
    this.visibilityEmitter = new vscode.EventEmitter(); this.onDidChangeVisibility = this.visibilityEmitter.event;
    this.subscription = model.onDidChangeTreeData(() => { this.publish().catch(fail); });
  }
  get visible() { return Boolean(this.view?.visible); }
  resolveWebviewView(view) {
    this.view = view; this.iconUris = new Map();
    const webview = view.webview;
    this.channel?.dispose();
    this.channel = new ViewChannel(webview, this.extensionUri, ['ready', 'filter', 'open', 'preview', 'toggle', 'menu'], message => this.handleMessage(message), this.fail);
    webview.options = { enableScripts: true, localResourceRoots: this.channel.roots() };
    webview.html = this.channel.document({ title: '文件符号', styles: ['media/symbols.css'], scripts: ['media/symbols.js'], images: true, body: `
<header><span class="file-tab" id="filename">未打开源码文件</span></header>
<div class="search"><input id="search" type="search" placeholder="搜索符号 / 头文件…" aria-label="搜索文件符号" autocomplete="off" spellcheck="false"><button id="clear" title="清空搜索" aria-label="清空搜索">×</button></div>
<div id="summary" role="status" aria-live="polite"></div>
<div id="symbols" role="tree" aria-label="文件符号" tabindex="0"></div>
` });
    this.closed?.dispose();
    const channel = this.channel;
    this.closed = view.onDidDispose(() => { if (this.channel === channel) { channel.dispose(); this.channel = undefined; this.view = undefined; } });
    this.visibilitySubscription?.dispose();
    this.visibilitySubscription = view.onDidChangeVisibility(() => this.visibilityEmitter.fire({ visible: view.visible }));
    this.publish().catch(this.fail);
  }
  async focusSearch() {
    this.searchRequested = true;
    await vscode.commands.executeCommand('sourceInsightInspired.symbols.focus');
    if (this.view) { this.searchRequested = false; await this.channel.postMessage({ focusSearch: true }); }
  }
  async handleMessage(message) {
    if (message.action === 'ready') {
      await this.publish();
      if (this.searchRequested) { this.searchRequested = false; await this.channel?.postMessage({ focusSearch: true }); }
      return;
    }
    if (message.action === 'filter' && typeof message.query === 'string') {
      await this.filter(message.query.slice(0, 1000)); return;
    }
    const node = this.targets.get(message.id); if (!node) return;
    const key = locationKey(target(node));
    if (message.action === 'menu') {
      const choice = await vscode.window.showQuickPick([
        { label: '文件夹字符检索', command: 'sourceInsightInspired.lookupText' },
        { label: '查询引用', command: 'sourceInsightInspired.lookupReferences' },
        { label: '设为 Relation 根节点', command: 'sourceInsightInspired.setRoot' }
      ], { placeHolder: node.name });
      if (choice && this.targets.get(message.id) === node) await vscode.commands.executeCommand(choice.command, node);
      return;
    }
    if (message.action === 'toggle') {
      if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
      return this.publish();
    }
    if (!['open', 'preview'].includes(message.action)) return;
    this.selection = [node]; this.selectionEmitter.fire({ selection: [node] });
    if (message.action === 'open') await this.open(node);
    await this.publish();
  }
  iconUri(name) {
    if (!this.iconUris) this.iconUris = new Map();
    if (!this.iconUris.has(name)) this.iconUris.set(name, this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, `media/symbol-icons/${name}.svg`)).toString());
    return this.iconUris.get(name);
  }
  async publish(reveal = false) {
    if (!this.view) return;
    if (this.uri !== this.model.uri || this.epoch !== this.model.selectionEpoch) {
      this.uri = this.model.uri; this.epoch = this.model.selectionEpoch; this.selection = []; this.collapsed.clear();
    }
    const targets = new Map(), rows = []; let total = 0, visibleCount = 0;
    const selected = this.selection[0] ? locationKey(target(this.selection[0])) : undefined;
    const walk = (nodes, depth, hidden = false) => {
      for (const node of nodes) {
        total++;
        const key = locationKey(target(node)), expanded = Boolean(this.model.query) || !this.collapsed.has(key);
        if (!hidden) visibleCount++;
        if (!hidden && rows.length < 2000) {
          const id = String(++this.serial); targets.set(id, node);
          rows.push({ id, key, depth, label: node.name, category: symbolCategory(node),
            iconKind: symbolIcon(node), icon: this.iconUri(symbolIcon(node)),
            tooltip: `${symbolCategory(node)}：${node.name}\n${node.detail || ''}\n${node.uri.fsPath || node.uri.path}:${node.selectionRange.start.line + 1}`,
            expandable: node.children.length > 0, expanded, selected: key === selected });
        }
        walk(node.children || [], depth + 1, hidden || !expanded);
      }
    };
    walk(this.model.displayed, 0); this.targets = targets;
    const uri = this.model.uri;
    await this.channel.postMessage({ filename: uri?.path.split('/').pop() || '未打开源码文件',
      path: uri?.fsPath || uri?.path || '', query: this.model.query, rows, total,
      truncated: visibleCount > 2000, reveal,
      summary: `${this.model.allSymbols ? '全部符号' : '函数'} · ${this.model.sort === 'name' ? '名称排序' : '源码顺序'} · ${total} 项`,
      message: this.model.query ? '无匹配符号' : this.model.message });
  }
  async reveal(node, options) {
    if (options.select) this.selection = [node];
    for (let parent = node.parent; parent; parent = parent.parent) this.collapsed.delete(locationKey(target(parent)));
    await this.publish(true);
  }
  dispose() { this.channel?.dispose(); this.closed?.dispose();
    this.subscription.dispose(); this.visibilitySubscription?.dispose();
    this.selectionEmitter.dispose(); this.visibilityEmitter.dispose(); this.targets.clear();
  }
}
module.exports = { SymbolView };
