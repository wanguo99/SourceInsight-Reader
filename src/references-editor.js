'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const { resultButton } = require('./result-toolbar');
const { RequestGate } = require('./core');

class ReferencesEditor {
  constructor(extensionUri, model, open, preview, fail, activate = () => {}, host) {
    this.host = host; this.activate = activate; this.extensionUri = extensionUri; this.model = model; this.open = open; this.preview = preview; this.fail = fail;
    this.selection = []; this.gate = new RequestGate(); this.targets = new Map(); this.serial = 0;
    this.subscription = model.onDidChangeTreeData(() => this.publish().catch(fail));
  }
  show() {
    this.activate();
    if (this.panel && !this.host) { this.panel.reveal(); return; }
    const panel = this.host ? this.host.createPanel('references') : vscode.window.createWebviewPanel('sourceInsightInspired.referenceResults', 'Lookup References',
      vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')], retainContextWhenHidden: true });
    this.panel = panel;
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/references.js'));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/references.css'));
    panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${style}"><link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/result-toolbar.css'))}"><title>Lookup References</title></head><body>
<header><label for="filter">筛选引用</label><input id="filter" type="search" placeholder="搜索文件路径或源码（Ctrl+F）" autocomplete="off">
${resultButton('refresh', '刷新', '')}${resultButton('history', '历史', '')}${resultButton('previous', '上一个', 'Shift+F8')}${resultButton('next', '下一个', 'F8')}${resultButton('clear', '清空', '')}</header>
<p id="status" role="status" aria-live="polite"></p><p id="source"></p><main id="results" aria-label="引用结果"></main>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.panelListeners?.();
    const messages = panel.webview.onDidReceiveMessage(message => {
      this.handle(message).catch(this.fail);
    });
    const active = panel.onDidChangeViewState?.(event => { if (event.webviewPanel.active) this.activate(); });
    const closed = panel.onDidDispose(() => {
      active?.dispose();
      messages.dispose(); closed.dispose();
      if (this.panel === panel) { this.panel = undefined; this.gate.invalidate(); this.targets.clear(); }
    });
    this.panelListeners = () => { messages.dispose(); active?.dispose(); closed.dispose(); };
    this.publish().catch(this.fail);
  }
  async handle(message) {
    if (!message || typeof message.action !== 'string') return;
    if (message.action === 'ready') return this.publish();
    if (message.action === 'filter' && typeof message.query === 'string') return this.model.filter(message.query);
    if (message.action === 'refresh' && this.model.source) return this.model.lookup(this.model.source);
    if (message.action === 'clear') return this.model.clear();
    const commands = { history: 'referenceHistory', next: 'nextReference', previous: 'previousReference' };
    if (commands[message.action]) return vscode.commands.executeCommand(`sourceInsightInspired.${commands[message.action]}`);
    const node = this.targets.get(message.id);
    if (!node) return;
    if (message.action === 'more' && node.type === 'referenceFile') { node.shown += 200; this.model.refresh(); return; }
    if (node.type !== 'reference') return;
    this.selection = [node];
    if (message.action === 'open' || message.action === 'pin') await this.open(node, message.action === 'pin');
    if (message.action === 'preview') await this.preview(node);
  }
  async publish() {
    if (!this.panel) return;
    const panel = this.panel, request = this.gate.next(), targets = new Map(), groups = [];
    for (const group of this.model.visibleGroups) {
      const children = await this.model.getChildren(group);
      if (!this.gate.current(request) || this.panel !== panel) return;
      const rows = children.filter(child => child.type === 'reference').map(child => {
        const id = String(++this.serial); targets.set(id, child);
        return { id, line: child.range.start.line + 1, column: child.range.start.character + 1,
          snippet: child.snippet, selected: this.selection[0] === child };
      });
      const id = String(++this.serial); targets.set(id, group);
      groups.push({ id, path: vscode.workspace.asRelativePath(group.uri), total: group.children.length, rows,
        more: group.children.length > group.shown });
    }
    if (!this.gate.current(request)) return;
    this.targets = targets;
    const count = this.model.allVisibleReferences().length;
    panel.title = this.model.source ? `引用: ${this.model.source.name || '符号'}` : 'Lookup References';
    await panel.webview.postMessage({ query: this.model.query, groups,
      shortcuts: vscode.workspace.getConfiguration('sourceInsightInspired').get('sourceInsightKeys', true),
      status: `${this.model.source?.name || 'Lookup References'} · ${count} 个引用${this.model.stale ? ' · 源码已修改，请刷新' : ''}${!count ? ` · ${this.model.message}` : ''}`,
      source: this.model.source ? `${vscode.workspace.asRelativePath(this.model.source.uri)}:${this.model.source.range.start.line + 1}` : '' });
  }
  async reveal(node, options) { if (options.select) this.selection = [node]; await this.publish(); }
  dispose() { this.subscription.dispose(); this.gate.dispose(); this.panel?.dispose(); }
}
module.exports = { ReferencesEditor };
