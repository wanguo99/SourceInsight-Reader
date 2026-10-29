'use strict';
const vscode = require('vscode');
const { t } = require('./i18n');
const { RequestGate, NavigationHistory } = require('./core');
const { errorText } = require('./trees');
const { highlightDocument, highlightDocumentAsync } = require('./syntax');
const { sameUri } = require('./resources');
const { THEME_ID, effectiveTheme } = require('./theme');
const { functionHeads, emphasizeHeads } = require('./function-heads');
const { scopedSettings } = require('./editor-color-settings');
const { colorTokens } = require('./preview-colors');
const { combinedColorSpans } = require('./infrastructure/c-color-spans');
const { Observable } = require('./domain/observable');
const { literalIncludes, literalIncludeAt } = require('./infrastructure/include-paths');

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
    const colors = language.localIndex?.onDidChange?.(() => {
      clearTimeout(this.colorTimer);
      this.colorTimer = setTimeout(() => { void this.refreshLocalColors?.(); }, 120);
      this.colorTimer.unref?.();
    });
    if (colors) this.disposables.push(colors);
  }

  async handleMessage(message) {
    switch (message.action) {
      case 'highlightSymbol': if (typeof message.symbol === 'string') await this.onHighlightSymbol(message.symbol); break;
      case 'ready': this.publish(); break;
      case 'navigate': await this.navigate(message); break;
      case 'lock': this.toggleLock(); this.onLockChanged?.(this.locked); break;
      case 'open': if (await this.validCurrent()) await this.open(this.current); break;
      case 'pin': await this.pin(); break;
      case 'fullFunction': await this.fullFunction(); break;
      case 'refresh': await this.refresh(); break;
      case 'mode': await vscode.commands.executeCommand('sourceInsightReader.contextMode'); break;
      case 'earlier': case 'later': {
        if (!this.current || this.locked) break;
        const margin = vscode.workspace.getConfiguration('sourceInsightReader').get('contextLines', 20);
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
        if (this.locked || !Number.isInteger(message.index) || message.snapshot !== this.snapshot) break;
        const candidate = this.candidates?.[message.index];
        if (candidate) await this.show({ ...candidate, mode: this.candidateMode, note: this.candidateNote }, { candidates: this.candidates });
        break;
      }
    }
  }

  resetScope() { this.history = new NavigationHistory(50); this.clear(); }
  clear() {
    this.gate.invalidate(); this.snapshot++; this.current = undefined;
    this.lastLocation = undefined; this.lastDefinition = undefined; this.candidates = []; this.refreshLocalColors = undefined;
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
    this.snapshot++;
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
      this.candidateNote = result.note;
      this.candidates = locations;
      if (locations.length > 1) {
        this.state = {
          status: `找到 ${locations.length} 个定义，请选择候选`, lines: [],
          candidates: this.labels(locations), candidateIndex: -1
        };
        this.publish(); return;
      }
      await this.show({ ...locations[0], mode: this.candidateMode, note: result.note }, { candidates: locations });
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
    this.state = { status: '正在加载预览…', lines: [], candidates: this.labels(this.candidates), loading: true,
      candidateIndex: this.candidates.findIndex(candidate => sameUri(candidate.uri, location.uri) && candidate.range.start.isEqual(location.range.start)) };
    this.publish();
    try {
      const document = await vscode.workspace.openTextDocument(location.uri);
      if (!this.gate.current(request)) return;
      const range = document.validateRange(location.range);
      const margin = vscode.workspace.getConfiguration('sourceInsightReader').get('contextLines', 20);
      const start = Math.max(0, options.extent?.start.line ?? range.start.line - margin);
      const end = Math.min(document.lineCount - 1, options.extent?.end.line ?? range.start.line + margin, start + 1999);
      const lines = [];
      const includes = literalIncludes(document);
      const highlighted = end < 256 ? highlightDocument(document, start, end) : undefined;
      for (let line = start; line <= end; line++) {
        const text = document.lineAt(line).text;
        const include = includes.find(value => value.range.start.line <= line && value.range.end.line >= line);
        const active = line >= range.start.line && line <= range.end.line;
        lines.push({ number: line + 1, text, tokens: highlighted?.[line - start] || [{ text, kind: 'plain' }],
          ...(include ? { includeRange: { start: include.range.start.line === line ? include.range.start.character : 0,
            end: include.range.end.line === line ? include.range.end.character : text.length } } : {}),
          start: active ? line === range.start.line ? range.start.character : 0 : -1,
          end: active ? line === range.end.line ? range.end.character : text.length : -1,
          active: line === range.start.line });
      }
      this.current = { ...location, range };
      this.documentVersion = document.version;
      this.snapshot++;
      if (options.history !== false) this.history.push(this.current);
      this.state = {
        status: `${t(location.mode || '源码')}${location.note ? ' · ' + t(location.note) : ''}${document.isDirty ? t(' · 未保存内容') : ''}${location.stale ? t(' · 位置可能过期，请重新定位符号') : ''}`,
        path: `${vscode.workspace.asRelativePath(location.uri)}:${range.start.line + 1}:${range.start.character + 1}`,
        lines, candidates: this.labels(this.candidates),
        candidateIndex: this.candidates.findIndex(candidate => sameUri(candidate.uri, location.uri) &&
          candidate.range.start.isEqual(range.start))
      };
      this.publish();
      const snapshot = this.snapshot;
      let heads = functionHeads(this.language.cachedSymbols?.(document) || [], document), spans = [], localSpans = [], lexicalSpans = [];
      const stylePreview = () => {
        // Locking cancels navigation, but the retained source can still receive
        // its grammar/semantic styles. A replaced or closed source cannot.
        if (this.disposed || this.snapshot !== snapshot || !this.current || !sameUri(this.current.uri, document.uri) ||
            document.isClosed || document.version !== this.documentVersion) return;
        const custom = vscode.workspace.getConfiguration('editor').get('semanticTokenColorCustomizations', /** @type {any} */ ({}));
        const overrides = scopedSettings(custom).map(layer => layer.rules || {});
        const colors = combinedColorSpans(localSpans, spans);
        this.state.lines = lines.map(line => ({ ...line,
          tokens: emphasizeHeads(colorTokens(line.tokens, line.number - 1, colors, document.languageId, overrides, lexicalSpans), line.number - 1, heads) }));
        this.publish();
      };
      stylePreview();
      if (!highlighted) highlightDocumentAsync(document, start, end, () => this.disposed || this.snapshot !== snapshot)
        .then(tokens => {
          if (!tokens.length || this.snapshot !== snapshot) return;
          for (let at = 0; at < lines.length; at++) lines[at].tokens = tokens[at];
          stylePreview();
        }).catch(() => {});
      if (this.language.symbols) Promise.resolve().then(() => this.language.symbols(location.uri)).then(nodes => {
        if (nodes.length) heads = functionHeads(nodes, document); stylePreview();
      }).catch(() => {});
      if (this.language.textmateTokens) Promise.resolve().then(() => this.language.textmateTokens(document, start, end)).then(tokens => {
        lexicalSpans = tokens; stylePreview();
      }).catch(() => {});
      let colorSequence = 0;
      this.refreshLocalColors = async () => {
        if (!this.language.localColorTokens || this.disposed || this.snapshot !== snapshot || !this.current || document.isClosed || document.version !== this.documentVersion) return;
        const sequence = ++colorSequence;
        try {
          const tokens = await this.language.localColorTokens(document, [new vscode.Range(start, 0, end, 0)]);
          if (sequence !== colorSequence || this.snapshot !== snapshot) return;
          localSpans = tokens.filter(span => span.line >= start && span.line <= end); stylePreview();
        } catch { /* Preserve this preview until a later index update can retry. */ }
      };
      void this.refreshLocalColors();
      if (this.language.semanticTokens) Promise.resolve().then(() => this.language.semanticTokens(location.uri, document.languageId)).then(tokens => {
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
    const include = literalIncludeAt(document, position);
    const word = include ? new vscode.Range(include.range.start.line, include.range.start.character, include.range.end.line, include.range.end.character) : document.getWordRangeAtPosition(position);
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
  async validCurrent() {
    if (!this.current) return false;
    const current = this.current, snapshot = this.snapshot;
    const document = await vscode.workspace.openTextDocument(current.uri);
    if (this.current !== current || this.snapshot !== snapshot) return false;
    if (document.version !== this.documentVersion) { this.state.status = '源码已修改，请刷新预览后再跳转'; this.publish(); return false; }
    return true;
  }
  async pin() {
    if (!await this.validCurrent()) return;
    const document = await vscode.workspace.openTextDocument(this.current.uri);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, selection: this.current.range, preview: false, preserveFocus: true });
  }
  async fullFunction() {
    if (!await this.validCurrent()) return;
    const current = this.current, snapshot = this.snapshot;
    const nodes = await this.language.symbols(current.uri);
    if (this.snapshot !== snapshot || !await this.validCurrent()) return;
    const { enclosingFunction } = require('./core');
    const node = enclosingFunction(nodes, current.range.start);
    if (!node) { this.state.status = '未找到包含函数，请使用向上 / 向下浏览'; this.publish(); return; }
    await this.show({ ...current, note: node.range.end.line - node.range.start.line >= 2000 ? '函数超过 2000 行，显示首段；可继续向下浏览' : current.note },
      { refresh: true, extent: node.range, history: false });
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
    this.state.highlightUseF2 = vscode.workspace.getConfiguration('sourceInsightReader').get('symbolHighlightUseF2', false);
    this.state.highlightSymbol = this.highlightSymbol || '';
    this.events.emit({ ...this.state, snapshot: this.snapshot,
      sourceInsight: effectiveTheme(vscode.workspace.getConfiguration('workbench').get('colorTheme')) === THEME_ID, locked: this.locked, canOpen: Boolean(this.current),
      canBack: this.history.index > 0, canForward: this.history.index < this.history.entries.length - 1 });
  }
  dispose() { this.disposed = true; clearTimeout(this.colorTimer); this.refreshLocalColors = undefined; this.events.dispose(); this.gate.dispose(); this.disposables.forEach(disposable => disposable.dispose()); }
}

module.exports = { ContextView };
