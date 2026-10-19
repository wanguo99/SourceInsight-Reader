'use strict';
const vscode = require('vscode');
const { RequestGate } = require('./core');
const { ViewChannel } = require('./infrastructure/view-channel');
const { resultButton } = require('./result-toolbar');
class SearchResultsView {
  constructor(extensionUri, sessions, fail) {
    this.extensionUri = extensionUri; this.sessions = sessions; this.fail = fail; this.mode = 'text'; this.gate = new RequestGate();
    this.subscriptions = Object.entries(sessions).map(([mode, session]) => session.onDidChange(() => { if (mode === this.mode) this.publish().catch(fail); }));
  }
  show(mode = this.mode) {
    if (!this.sessions[mode]) return; this.mode = mode;
    this.view?.show(true); vscode.commands.executeCommand('sourceInsightInspired.searchResults.focus').then(undefined, this.fail);
    this.publish().catch(this.fail);
  }
  resolveWebviewView(view) {
    this.channel?.dispose(); this.closed?.dispose(); this.view = view;
    this.channel = new ViewChannel(view.webview, this.extensionUri,
      ['ready', 'switchResults', 'search', 'refresh', 'cancel', 'clear', 'history', 'next', 'previous', 'pageNext', 'pagePrevious', 'open', 'preview', 'pin'], message => this.handle(message), this.fail);
    view.webview.options = { enableScripts: true, localResourceRoots: this.channel.roots() };
    view.webview.html = this.channel.document({ title: 'Search Results', styles: ['media/text-lookup.css', 'media/result-toolbar.css'], scripts: ['media/search-results.js'], body: `
<header aria-label="检索类型"><button id="lookupTextTab">字符检索</button><button id="lookupReferencesTab">引用检索</button></header>
<header><input id="query" type="search" maxlength="1000" aria-label="检索字符或筛选引用" autocomplete="off">
<select id="folder" aria-label="检索文件夹"></select><label id="caseLabel"><input id="matchCase" type="checkbox">区分大小写</label><label id="wordLabel"><input id="wholeWord" type="checkbox">全词</label>
${resultButton('search', '检索 / 筛选', 'Enter')}${resultButton('refresh', '刷新')}${resultButton('history', '历史')}${resultButton('previous', '上一个', 'Shift+F8')}${resultButton('next', '下一个', 'F8')}${resultButton('clear', '清空')}${resultButton('cancel', '取消')}</header>
<div id="status" role="status" aria-live="polite"></div><div class="content"><aside id="historyPane"><h2>Search Results</h2><div id="historyList"></div></aside><main><table><thead><tr><th>所在函数 / 类型</th><th>文件 : 行 : 列</th><th>匹配源码</th></tr></thead><tbody id="results"></tbody></table></main></div>
<footer><button id="pagePrevious">上一页</button><span id="page"></span><button id="pageNext">下一页</button></footer>` });
    const channel = this.channel;
    this.closed = view.onDidDispose(() => { if (this.channel === channel) { channel.dispose(); this.channel = undefined; this.view = undefined; this.gate.invalidate(); } });
    this.publish().catch(this.fail);
  }
  async handle(message) {
    if (message.action === 'ready') return this.publish();
    if (message.action === 'switchResults') { if (this.sessions[message.mode]) { this.mode = message.mode; await this.publish(); } return; }
    if (message.mode !== this.mode) return;
    await this.sessions[this.mode].handle(message);
  }
  async publish() {
    if (!this.channel) return;
    const request = this.gate.next(), mode = this.mode;
    const state = await this.sessions[mode].snapshot();
    if (state && this.gate.current(request) && mode === this.mode) await this.channel.postMessage({ ...state,
      shortcuts: vscode.workspace.getConfiguration('sourceInsightInspired').get('sourceInsightKeys', true) });
  }
  move(direction) { return this.sessions[this.mode].move(direction); }
  async launchText(query, uri) { this.show('text'); await this.sessions.text.launch(query, uri); }
  dispose() { this.gate.dispose(); this.channel?.dispose(); this.closed?.dispose(); this.subscriptions.forEach(value => value.dispose()); }
}
module.exports = { SearchResultsView };
