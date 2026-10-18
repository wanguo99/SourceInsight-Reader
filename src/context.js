'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const { RequestGate, NavigationHistory } = require('./core');
const { errorText } = require('./trees');
const { highlightLine } = require('./syntax');
const { sameUri } = require('./resources');

class ContextView {
  constructor(extensionUri, language, open, locked = false) {
    this.extensionUri = extensionUri;
    this.language = language;
    this.open = open;
    /** @type {(locked: boolean) => void} */
    this.onLockChanged = () => {};
    this.locked = locked;
    this.gate = new RequestGate();
    this.history = new NavigationHistory(50);
    this.state = { status: '选择代码中的符号以查看定义', lines: [], candidates: [] };
    this.disposables = [];
  }

  resolveWebviewView(view) {
    this.view = view;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/context.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/context.css'));
    webview.html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>Context</title></head>
<body><nav aria-label="预览工具栏">
<button id="lock" type="button">锁定</button><button id="refresh" type="button">刷新</button>
<button id="back" type="button" title="预览历史后退">←</button><button id="forward" type="button" title="预览历史前进">→</button>
<button id="earlier" type="button">向上浏览</button><button id="later" type="button">向下浏览</button>
<button id="open" type="button">在主编辑器打开</button></nav>
<div id="status" role="status" aria-live="polite"></div>
<div id="path"></div><select id="candidates" aria-label="定义候选" hidden></select>
<pre id="code" tabindex="0" aria-label="只读源码预览"></pre>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.disposables.push(webview.onDidReceiveMessage(message => {
      if (!message || typeof message.action !== 'string') return;
      Promise.resolve(this.handleMessage(message)).catch(error => this.fail(error));
    }));
    this.disposables.push(view.onDidChangeVisibility(() => { if (view.visible) this.publish(); }));
    this.disposables.push(view.onDidDispose(() => { if (this.view === view) this.view = undefined; }));
    this.publish();
  }

  async handleMessage(message) {
    switch (message.action) {
      case 'ready': this.publish(); break;
      case 'lock': this.toggleLock(); this.onLockChanged?.(this.locked); break;
      case 'open': if (this.current) await this.open(this.current); break;
      case 'refresh': await this.refresh(); break;
      case 'earlier': case 'later': {
        if (!this.current || this.locked) break;
        const margin = vscode.workspace.getConfiguration('sourceReader', this.current.uri).get('contextLines', 20);
        const line = Math.max(0, this.current.range.start.line + (message.action === 'earlier' ? -margin : margin));
        await this.show({ ...this.current, range: new vscode.Range(line, 0, line, 0) }, { refresh: true, candidates: this.candidates });
        break;
      }
      case 'back': case 'forward': {
        if (this.locked) break;
        const previous = message.action === 'back' ? this.history.back() : this.history.forward();
        if (previous) await this.show(previous, { history: false });
        break;
      }
      case 'candidate': {
        if (this.locked || !Number.isInteger(message.index)) break;
        const candidate = this.candidates?.[message.index];
        if (candidate) await this.show({ ...candidate, mode: this.candidateMode }, { candidates: this.candidates });
        break;
      }
    }
  }

  invalidateAuto() { if (!this.locked) this.gate.invalidate(); }
  toggleLock() {
    this.gate.invalidate(); this.locked = !this.locked;
    if (!this.current) this.state = { status: this.locked ? '已锁定；解锁后选择符号' : '选择符号以查看定义', lines: [], candidates: [] };
    else if (this.state.loading) this.state.status = '已取消查询；可刷新当前预览';
    this.state.loading = false; this.publish();
    return this.locked;
  }

  async definition(source, type = false) {
    if (this.locked) return;
    this.lastDefinition = { source, type };
    this.lastLocation = undefined;
    const request = this.gate.next();
    this.current = undefined;
    this.candidates = [];
    this.state = { status: `正在查询${type ? '类型' : ''}定义…`, lines: [], candidates: [], loading: true };
    this.publish();
    try {
      const locations = await this.language.definitions(source.uri, source.range.start, type);
      if (!this.gate.current(request)) return;
      if (!locations.length) {
        this.state = { status: '没有定义结果；服务可能未就绪或不支持，请配置语言服务后重试', lines: [], candidates: [] };
        this.publish(); return;
      }
      this.candidateMode = type ? '类型定义' : '定义';
      this.candidates = locations;
      if (locations.length > 1) {
        this.state = {
          status: `找到 ${locations.length} 个定义，请选择候选`, lines: [],
          candidates: this.labels(locations), candidateIndex: -1
        };
        this.publish(); return;
      }
      await this.show({ ...locations[0], mode: this.candidateMode }, { candidates: locations });
    } catch (error) { if (this.gate.current(request)) this.fail(error); }
  }

  labels(locations) {
    return locations.map(location => `${vscode.workspace.asRelativePath(location.uri)}:${location.range.start.line + 1}:${location.range.start.character + 1}`);
  }

  async show(location, options = {}) {
    if (this.locked && !options.refresh) return;
    this.lastLocation = location;
    const request = this.gate.next();
    this.current = undefined;
    this.candidates = options.candidates || [];
    this.state = { status: '正在加载预览…', lines: [], candidates: [], loading: true };
    this.publish();
    try {
      const document = await vscode.workspace.openTextDocument(location.uri);
      if (!this.gate.current(request)) return;
      const range = document.validateRange(location.range);
      const margin = vscode.workspace.getConfiguration('sourceReader', location.uri).get('contextLines', 20);
      const start = Math.max(0, range.start.line - margin);
      const end = Math.min(document.lineCount - 1, range.start.line + margin);
      const lines = [];
      const lexer = { block: false, rawEnd: '' };
      // Recover nearby comment/raw-string state without scanning an unbounded document.
      for (let line = Math.max(0, start - 400); line < start; line++) highlightLine(document.lineAt(line).text, lexer, document.languageId);
      for (let line = start; line <= end; line++) {
        const text = document.lineAt(line).text;
        const active = line >= range.start.line && line <= range.end.line;
        lines.push({ number: line + 1, text, tokens: highlightLine(text, lexer, document.languageId),
          start: active ? line === range.start.line ? range.start.character : 0 : -1,
          end: active ? line === range.end.line ? range.end.character : text.length : -1,
          active: line === range.start.line });
      }
      this.current = { ...location, range };
      if (options.history !== false) this.history.push(this.current);
      this.state = {
        status: `${location.mode || '源码'}${document.isDirty ? ' · 未保存内容' : ''}${location.stale ? ' · 位置可能过期，请重新定位符号' : ''}`,
        path: `${vscode.workspace.asRelativePath(location.uri)}:${range.start.line + 1}:${range.start.character + 1}`,
        lines, candidates: this.labels(this.candidates),
        candidateIndex: this.candidates.findIndex(candidate => sameUri(candidate.uri, location.uri) &&
          candidate.range.start.isEqual(range.start))
      };
      this.publish();
    } catch (error) { if (this.gate.current(request)) this.fail(error); }
  }

  async refresh() {
    if (this.current || this.lastLocation) await this.show(this.current || this.lastLocation, { refresh: true, history: false, candidates: this.candidates });
    else if (!this.locked && this.lastDefinition) await this.definition(this.lastDefinition.source, this.lastDefinition.type);
  }
  fail(error) {
    this.current = undefined;
    this.state = { status: `预览失败：${errorText(error)}`, lines: [], candidates: [] };
    this.publish();
  }
  publish() {
    if (!this.view) return;
    this.view.description = this.locked ? '已锁定' : '自动跟随';
    this.view.webview.postMessage({ ...this.state, locked: this.locked, canOpen: Boolean(this.current),
      canBack: this.history.index > 0, canForward: this.history.index < this.history.entries.length - 1 });
  }
  dispose() { this.gate.dispose(); this.disposables.forEach(disposable => disposable.dispose()); }
}

module.exports = { ContextView };
