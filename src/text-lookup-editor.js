'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const { resultButton } = require('./result-toolbar');
const { folderFor } = require('./text-lookup');
const PAGE_SIZE = 300;

class TextLookupEditor {
  constructor(context, model, open, preview, activate, fail, host) {
    this.host = host; this.context = context; this.model = model; this.open = open; this.preview = preview; this.activate = activate; this.fail = fail;
    this.page = 0; this.subscription = model.onDidChange(() => this.publish().catch(fail));
  }
  show() {
    this.activate();
    if (this.panel && !this.host) { this.panel.reveal(); return; }
    const panel = this.host ? this.host.createPanel('text') : vscode.window.createWebviewPanel('sourceInsightInspired.textLookup', 'Search Results',
      vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')], retainContextWhenHidden: true });
    this.panel = panel;
    const nonce = crypto.randomBytes(16).toString('hex');
    const asset = name => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, `media/${name}`));
    panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${asset('text-lookup.css')}"><link rel="stylesheet" href="${asset('result-toolbar.css')}"><title>Search Results</title></head><body>
<header><input id="query" type="search" maxlength="256" aria-label="检索字符" placeholder="输入变量名、函数名或字符，Enter 检索">
<select id="folder" aria-label="检索文件夹"></select><label><input id="matchCase" type="checkbox">区分大小写</label><label><input id="wholeWord" type="checkbox">全词</label>
${resultButton('search', '检索', 'Enter')}${resultButton('refresh', '刷新', '')}${resultButton('cancel', '取消', '')}${resultButton('previous', '上一个', 'Shift+F8')}${resultButton('next', '下一个', 'F8')}</header>
<div id="status" role="status" aria-live="polite"></div><div class="content"><aside><h2>Search Results</h2><div id="history"></div></aside><main><table><thead><tr><th>所在函数</th><th>文件 : 行 : 列</th><th>匹配源码</th></tr></thead><tbody id="results"></tbody></table></main></div>
<footer><button id="pagePrevious">上一页</button><span id="page"></span><button id="pageNext">下一页</button></footer>
<script nonce="${nonce}" src="${asset('text-lookup.js')}"></script></body></html>`;
    this.panelListeners?.();
    const messages = panel.webview.onDidReceiveMessage(message => this.handle(message).catch(this.fail));
    const active = panel.onDidChangeViewState?.(event => { if (event.webviewPanel.active) this.activate(); });
    const closed = panel.onDidDispose(() => {
      messages.dispose(); active?.dispose(); closed.dispose(); if (this.panel === panel) this.panel = undefined;
    });
    this.panelListeners = () => { messages.dispose(); active?.dispose(); closed.dispose(); };
    this.publish().catch(this.fail);
  }
  async launch(query, uri) {
    this.show(); this.page = 0;
    const roots = vscode.workspace.workspaceFolders || [];
    const folder = folderFor(uri) || this.model.folder && roots.find(root => root.uri.toString() === this.model.folder.uri.toString()) || roots[0];
    await this.model.search(query, folder);
  }
  async handle(message) {
    if (!message || typeof message.action !== 'string') return;
    this.activate();
    if (message.action === 'ready') return this.publish();
    if (message.action === 'search') {
      if (typeof message.query !== 'string') return;
      const folder = (vscode.workspace.workspaceFolders || []).find(root => root.uri.toString() === message.folder);
      this.page = 0; return this.model.search(message.query, folder, message);
    }
    if (message.action === 'refresh') { this.page = 0; return this.model.search(this.model.query || '', this.model.folder); }
    if (message.action === 'cancel') {
      if (this.model.busy) { this.model.markStale(); this.model.message = '检索已取消，请重新检索'; this.model.changed(); }
      return;
    }
    if (message.action === 'next') return this.move(1);
    if (message.action === 'previous') return this.move(-1);
    if (message.action === 'pageNext' || message.action === 'pagePrevious') {
      this.page = Math.max(0, Math.min(Math.ceil(this.model.rows.length / PAGE_SIZE) - 1, this.page + (message.action === 'pageNext' ? 1 : -1)));
      return this.publish();
    }
    if (message.action === 'history') {
      const item = this.model.history.find(item => item.id === message.id);
      if (!item) return;
      const folder = (vscode.workspace.workspaceFolders || []).find(root => root.uri.toString() === item.folder);
      this.page = 0; return this.model.search(item.query, folder, item);
    }
    if (!['open', 'preview', 'pin'].includes(message.action)) return;
    const row = this.model.rows.find(row => row.id === message.id); if (!row) return;
    return this.navigate(row, message.action !== 'preview', message.action === 'pin');
  }
  async navigate(row, open = true, pinned = false) {
    const request = this.model.gate.version;
    if (!await this.model.validate(row) || !this.model.gate.current(request)) return;
    this.model.selected = this.model.rows.indexOf(row); this.page = Math.floor(this.model.selected / PAGE_SIZE);
    if (open) await this.open(row, pinned);
    if (!this.model.gate.current(request)) return;
    if (!open) await this.preview({ type: 'reference', ...row, mode: '字符匹配' });
    await this.publish();
  }
  async move(direction) {
    const model = this.model;
    if (!model.rows.length || model.busy || model.stale) return;
    const index = model.selected < 0 ? direction > 0 ? 0 : model.rows.length - 1
      : (model.selected + direction + model.rows.length) % model.rows.length;
    return this.navigate(model.rows[index]);
  }
  async publish() {
    if (!this.panel) return;
    const model = this.model, roots = vscode.workspace.workspaceFolders || [];
    const pages = Math.max(1, Math.ceil(model.rows.length / PAGE_SIZE)); this.page = Math.max(0, Math.min(this.page, pages - 1));
    // Stable, opaque history IDs avoid accepting arbitrary URI/query payloads.
    for (const item of model.history) item.id ||= crypto.randomBytes(6).toString('hex');
    const rows = model.rows.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE).map(row => ({
      id: row.id, owner: row.owner, path: row.path, line: row.line + 1, column: row.start + 1,
      before: row.before, matched: row.matched, after: row.after, selected: model.rows[model.selected] === row
    }));
    this.panel.title = model.query ? `Search Results: ${model.query}` : 'Search Results';
    await this.panel.webview.postMessage({ query: model.query || '', folder: model.folder?.uri.toString(), folders: roots.map(root => ({ id: root.uri.toString(), name: root.name })),
      ...model.options, session: model.gate.version, rows, history: model.history.map(item => ({ ...item })), page: this.page + 1, pages,
      busy: Boolean(model.busy), stale: Boolean(model.stale), status: model.message,
      shortcuts: vscode.workspace.getConfiguration('sourceInsightInspired').get('sourceInsightKeys', true),
      selected: model.selected < 0 ? '' : `${model.selected + 1} / ${model.rows.length}` });
  }
  dispose() { this.subscription.dispose(); this.panel?.dispose(); }
}
module.exports = { TextLookupEditor };
