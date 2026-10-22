'use strict';
const vscode = require('vscode');
const { RequestGate, NavigationHistory } = require('./core');
const { errorText } = require('./trees');
const { highlightDocument } = require('./syntax');
const { sameUri } = require('./resources');
const { THEME_ID } = require('./theme');
const { functionHeads, emphasizeHeads } = require('./function-heads');
const { colorTokens } = require('./preview-colors');
const { Observable } = require('./domain/observable');

class ContextView {
  constructor(language, open, locked = false) {
    this.language = language;
    this.open = open;
    /** @type {(locked: boolean) => void} */
    this.onLockChanged = () => {};
    this.locked = locked;
    this.onNavigate = () => {};
    this.onHighlightSymbol = symbol => {};
    this.highlightSymbol = '';
    this.snapshot = 0;
    this.events = new Observable(); this.onDidChange = listener => this.events.subscribe(listener);
    this.gate = new RequestGate();
    this.history = new NavigationHistory(50);
    this.state = { status: '选择代码中的符号以查看定义', lines: [], candidates: [] };
    this.disposables = [];
  }

  async handleMessage(message) {
    switch (message.action) {
      case 'highlightSymbol': if (typeof message.symbol === 'string') await this.onHighlightSymbol(message.symbol); break;
      case 'ready': this.publish(); break;
      case 'navigate': await this.navigate(message); break;
      case 'lock': this.toggleLock(); this.onLockChanged?.(this.locked); break;
      case 'open': if (this.current) await this.open(this.current); break;
      case 'refresh': await this.refresh(); break;
      case 'mode': await vscode.commands.executeCommand('sourceInsightReader.contextMode'); break;
      case 'earlier': case 'later': {
        if (!this.current || this.locked) break;
        const margin = vscode.workspace.getConfiguration('sourceInsightReader', this.current.uri).get('contextLines', 20);
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

  resetScope() { this.history = new NavigationHistory(50); this.clear(); }
  clear() {
    this.gate.invalidate(); this.snapshot++; this.current = undefined;
    this.lastLocation = undefined; this.lastDefinition = undefined; this.candidates = [];
    this.state = { status: '选择代码中的符号以查看定义', lines: [], candidates: [] }; this.publish();
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
        this.state = { status: result.note || '没有项目范围内的定义结果；请检查检索 / 屏蔽目录和语言服务配置', lines: [], candidates: [] };
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
    if (this.language.allowed && !this.language.allowed(location.uri)) return;
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
      const margin = vscode.workspace.getConfiguration('sourceInsightReader', location.uri).get('contextLines', 20);
      const start = Math.max(0, range.start.line - margin);
      const end = Math.min(document.lineCount - 1, range.start.line + margin);
      const lines = [];
      const highlighted = highlightDocument(document, start, end);
      for (let line = start; line <= end; line++) {
        const text = document.lineAt(line).text;
        const active = line >= range.start.line && line <= range.end.line;
        lines.push({ number: line + 1, text, tokens: highlighted[line - start],
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
      let heads = [], spans = [];
      const stylePreview = () => {
        if (!this.gate.current(request) || document.isClosed || document.version !== this.documentVersion) return;
        const custom = vscode.workspace.getConfiguration('editor', location.uri).get('semanticTokenColorCustomizations', /** @type {any} */ ({}));
        const overrides = { ...custom.rules, ...custom[`[${THEME_ID}]`]?.rules };
        this.state.lines = lines.map(line => ({ ...line,
          tokens: emphasizeHeads(colorTokens(line.tokens, line.number - 1, spans, document.languageId, overrides), line.number - 1, heads) }));
        this.publish();
      };
      stylePreview();
      if (this.language.symbols) Promise.resolve().then(() => this.language.symbols(location.uri)).then(nodes => {
        heads = functionHeads(nodes, document); stylePreview();
      }).catch(() => {});
      if (this.language.semanticTokens) Promise.resolve().then(() => this.language.semanticTokens(location.uri)).then(tokens => {
        spans = tokens; stylePreview();
      }).catch(() => {});
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
    this.state.highlightUseF2 = vscode.workspace.getConfiguration('sourceInsightReader').get('symbolHighlightUseF2', true);
    this.state.highlightSymbol = this.highlightSymbol || '';
    this.events.emit({ ...this.state, snapshot: this.snapshot,
      sourceInsight: vscode.workspace.getConfiguration('workbench').get('colorTheme') === THEME_ID, locked: this.locked, canOpen: Boolean(this.current),
      canBack: this.history.index > 0, canForward: this.history.index < this.history.entries.length - 1 });
  }
  dispose() { this.events.dispose(); this.gate.dispose(); this.disposables.forEach(disposable => disposable.dispose()); }
}

module.exports = { ContextView };
