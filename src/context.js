'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const { RequestGate, NavigationHistory } = require('./core');
const { errorText } = require('./trees');
const { highlightLine } = require('./syntax');
const { sameUri } = require('./resources');
const { THEME_ID } = require('./appearance');

class ContextView {
  constructor(extensionUri, language, open, locked = false) {
    this.extensionUri = extensionUri;
    this.language = language;
    this.open = open;
    /** @type {(locked: boolean) => void} */
    this.onLockChanged = () => {};
    this.locked = locked;
    this.onNavigate = () => {};
    this.snapshot = 0;
    /** @type {any} */
    this.relationPane = undefined;
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
    const panelStyle = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/reading-panel.css'));
    const relationScript = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/relation.js'));
    const relationLayout = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/relation-layout.js'));
    webview.html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><link rel="stylesheet" href="${panelStyle}"><title>Context / Relation</title></head>
<body><section id="context-pane" aria-label="Context"><h2 class="pane-title context-heading"><span>Context</span><span id="status" role="status" aria-live="polite"></span><span id="path"></span></h2>
<header id="metadata" hidden><select id="candidates" aria-label="定义候选" hidden></select></header>
<pre id="code" tabindex="0" aria-label="只读源码预览"></pre>
<nav aria-label="预览工具栏">
<button id="back" type="button" title="预览历史后退（Alt+, / 鼠标后退键）" aria-label="预览历史后退">←</button>
<button id="forward" type="button" title="预览历史前进（Alt+. / 鼠标前进键）" aria-label="预览历史前进">→</button>
<button id="open" type="button" title="在主编辑器打开" aria-label="在主编辑器打开">↗</button>
<span class="separator" aria-hidden="true"></span>
<button id="earlier" type="button" title="向上浏览" aria-label="向上浏览">↑</button><button id="later" type="button" title="向下浏览" aria-label="向下浏览">↓</button>
<span class="separator" aria-hidden="true"></span>
<button id="lock" type="button">锁定</button><button id="refresh" type="button" title="刷新" aria-label="刷新">⟳</button>
<button id="mode" type="button" title="Context 跟随模式" aria-label="Context 跟随模式">⚙</button></nav></section>
<div id="reading-splitter" role="separator" tabindex="0" aria-label="调整 Context 和 Relation 宽度" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="60"></div>
<section id="relation-pane" aria-label="Relation"><h2 class="pane-title relation-heading"><span>Relation</span><span id="relation-status" role="status">请选择函数</span></h2><div id="relation-tree" role="tree" tabindex="0" aria-label="调用关系"></div>
<nav aria-label="Relation 工具栏"><button id="relation-view" type="button" title="选择横向关系图或树形列表" aria-label="选择 Relation 显示方式">视图</button><button id="relation-incoming" type="button">谁调用它</button><button id="relation-outgoing" type="button">它调用谁</button>
<button id="relation-collapse" type="button">折叠</button><button id="relation-open" type="button" title="在主编辑器打开" aria-label="在主编辑器打开">↗</button>
<button id="relation-references" type="button">引用</button><button id="relation-root" type="button">设为根</button>
<button id="relation-lock" type="button">锁定</button><button id="relation-refresh" type="button" title="刷新" aria-label="刷新">⟳</button></nav></section>
<script nonce="${nonce}" src="${script}"></script><script nonce="${nonce}" src="${relationLayout}"></script><script nonce="${nonce}" src="${relationScript}"></script></body></html>`;
    this.disposables.push(webview.onDidReceiveMessage(message => {
      if (!message || typeof message.action !== 'string') return;
      Promise.resolve(this.handleMessage(message)).catch(error => this.fail(error));
    }));
    this.disposables.push(view.onDidChangeVisibility(() => { if (view.visible) { this.publish(); this.relationPane?.publish().catch(error => this.fail(error)); } }));
    this.disposables.push(view.onDidDispose(() => { if (this.view === view) this.view = undefined; }));
    this.publish();
  }

  async handleMessage(message) {
    if (message.action.startsWith('relation.')) return this.relationPane?.handleMessage(message).catch(error => this.relationPane.fail(error));
    switch (message.action) {
      case 'ready': this.publish(); await this.relationPane?.publish(); break;
      case 'navigate': await this.navigate(message); break;
      case 'lock': this.toggleLock(); this.onLockChanged?.(this.locked); break;
      case 'open': if (this.current) await this.open(this.current); break;
      case 'refresh': await this.refresh(); break;
      case 'mode': await vscode.commands.executeCommand('sourceInsightInspired.contextMode'); break;
      case 'earlier': case 'later': {
        if (!this.current || this.locked) break;
        const margin = vscode.workspace.getConfiguration('sourceInsightInspired', this.current.uri).get('contextLines', 20);
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
      const result = this.language.contextDefinitions
        ? await this.language.contextDefinitions(source.uri, source.range.start, type)
        : { locations: await this.language.definitions(source.uri, source.range.start, type), mode: type ? '类型定义' : '定义' };
      const locations = result.locations;
      if (!this.gate.current(request)) return;
      if (!locations.length) {
        this.state = { status: '没有定义结果；服务可能未就绪或不支持，请配置语言服务后重试', lines: [], candidates: [] };
        this.publish(); return;
      }
      this.candidateMode = result.mode;
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
      const margin = vscode.workspace.getConfiguration('sourceInsightInspired', location.uri).get('contextLines', 20);
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
      this.documentVersion = document.version;
      this.snapshot++;
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

  async navigate(message) {
    if (this.locked || !this.current || message.snapshot !== this.snapshot ||
      !Number.isInteger(message.line) || !Number.isInteger(message.character)) return;
    const line = this.state.lines.find(row => row.number === message.line + 1);
    if (!line || message.character < 0 || message.character >= line.text.length) return;
    const document = await vscode.workspace.openTextDocument(this.current.uri);
    if (message.snapshot !== this.snapshot || !this.current) return;
    if (document.version !== this.documentVersion) {
      this.state.status = '源码已修改，请刷新预览后再跳转'; this.publish(); return;
    }
    const position = new vscode.Position(message.line, message.character);
    const word = document.getWordRangeAtPosition(position);
    if (!word) return;
    const previous = this.current;
    const source = { uri: previous.uri, range: word };
    this.onNavigate();
    const pending = this.definition(source, Boolean(message.type));
    const request = this.gate.version;
    await pending;
    if (this.gate.current(request) && !this.current && !this.state.candidates.length) {
      const status = this.state.status;
      const restoring = this.show(previous, { history: false });
      const restoreRequest = this.gate.version;
      await restoring;
      if (this.gate.current(restoreRequest)) { this.state.status = `${status} · 保留原预览`; this.publish(); }
    }
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
    this.view.webview.postMessage({ ...this.state, snapshot: this.snapshot,
      sourceInsight: vscode.workspace.getConfiguration('workbench').get('colorTheme') === THEME_ID, locked: this.locked, canOpen: Boolean(this.current),
      canBack: this.history.index > 0, canForward: this.history.index < this.history.entries.length - 1 });
  }
  dispose() { this.gate.dispose(); this.disposables.forEach(disposable => disposable.dispose()); }
}

module.exports = { ContextView };
