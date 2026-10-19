'use strict';
const vscode = require('vscode');
const { LanguageAdapter } = require('./language');
const { SymbolTree, RelationTree, ReferencesTree, target, errorText } = require('./trees');
const { ContextView } = require('./context');
const { ReferencesEditor } = require('./references-editor');
const { NavigationHistory, RequestGate, enclosingFunction, locationKey } = require('./core');
const { sameUri } = require('./resources');
const { ReadingPickers } = require('./pickers');
const { ReadingAppearance } = require('./appearance');
const { ReadingLayout } = require('./layout');
const { RelationPane } = require('./relation-pane');
const { LocalIndex } = require('./local-index');
const { registerLocalDefinitions } = require('./definition-provider');

class ReadingController {
  constructor(context) {
    this.disposed = false;
    this.context = context;
    this.disposables = [];
    this.mainGate = new RequestGate();
    this.followGate = new RequestGate();
    this.jumpGate = new RequestGate();
    this.navigationGate = new RequestGate();
    this.navigationDepth = 0;
    this.revealingSymbols = 0;
    this.history = new NavigationHistory();
    this.output = vscode.window.createOutputChannel('Source Insight Inspired');
    this.localIndex = new LocalIndex(context, message => this.output.appendLine(message));
    this.language = new LanguageAdapter(this.localIndex);
    this.disposables.push(this.localIndex, registerLocalDefinitions(this.localIndex));
    this.layout = new ReadingLayout(context);
    this.appearance = new ReadingAppearance(context, error => this.run(() => { throw error; }, true));
    this.disposables.push(this.appearance);
    this.symbols = new SymbolTree(this.language);
    this.symbols.query = context.workspaceState.get('symbolQuery', '');
    this.symbols.sort = vscode.workspace.getConfiguration('sourceInsightInspired').get('symbolSort', 'position');
    this.symbols.allSymbols = vscode.workspace.getConfiguration('sourceInsightInspired').get('symbolKinds', String('all')) === 'all';
    this.symbols.refresh();
    this.relations = new RelationTree(this.language, description => { this.relationView.description = description; });
    // A lock without its target is not restored across reloads.
    this.references = new ReferencesTree(this.language, () => {
      this.run(() => vscode.commands.executeCommand('setContext', 'sourceInsightInspired.hasReferences', Boolean(this.references.visibleGroups.length && !this.references.stale)));
    });
    this.preview = new ContextView(context.extensionUri, this.language, source => this.openTarget(source));
    this.pickers = new ReadingPickers(this.language, source => this.openTarget(source), async source => {
      this.clearFollowTimer(); this.lastPreviewKey = undefined; await this.preview.show(source);
    }, error => this.run(() => { throw error; }, true));
    this.symbolView = vscode.window.createTreeView('sourceInsightInspired.symbols', { treeDataProvider: this.symbols, showCollapseAll: true });
    this.relationView = new RelationPane(this.relations, () => this.preview.view?.webview,
      node => this.openTarget(node), error => this.run(() => { throw error; }, true));
    this.preview.relationPane = this.relationView;
    this.referencesView = new ReferencesEditor(context.extensionUri, this.references,
      node => { this.currentReference = node; return this.openTarget(node); }, node => this.selectTarget(node), error => this.run(() => { throw error; }, true));
    this.disposables.push(this.output, this.symbols, this.relations, this.references,
      this.preview, this.pickers, this.symbolView, this.relationView, this.referencesView,
      vscode.window.registerWebviewViewProvider('sourceInsightInspired.context', this.preview));
    this.registerCommands();
    this.registerEvents();
    this.relations.updateLabel();
    this.syncSymbolDescription();
    this.run(() => this.layout.initialize());
    this.run(() => this.acceptEditor(vscode.window.activeTextEditor));
  }

  run(action, notify = false) {
    return Promise.resolve().then(() => { if (!this.disposed) return action(); }).catch(error => {
      if (this.disposed) return;
      this.output.appendLine(`${new Date().toISOString()} ${errorText(error)}`);
      if (notify) vscode.window.showErrorMessage(`Source Insight Inspired：${errorText(error)}`);
    });
  }
  command(name, action) {
    this.disposables.push(vscode.commands.registerCommand(`sourceInsightInspired.${name}`, (...args) => this.run(() => action(...args), true)));
  }
  config(name, fallback) {
    return vscode.workspace.getConfiguration('sourceInsightInspired', this.mainEditor?.document.uri).get(name, fallback);
  }

  registerCommands() {
    this.command('applyLayout', () => this.layout.apply());
    this.command('restoreSidebar', () => this.layout.restore());
    this.command('chooseAppearance', () => this.appearance.choose());
    this.command('restoreAppearance', () => this.appearance.restore());
    this.command('focusSymbols', () => vscode.commands.executeCommand('sourceInsightInspired.symbols.focus'));
    this.command('focusContext', () => vscode.commands.executeCommand('sourceInsightInspired.context.focus'));
    this.command('focusRelations', async () => {
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus'); await this.relationView.focus();
    });
    this.command('chooseRelationView', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: '横向关系图', description: '调用者 → 当前函数 → 调用函数，各一层', value: 'horizontalGraph' },
        { label: '树形列表', description: '保留原有 Outline，多级展开并切换调用方向', value: 'outline' }
      ], { placeHolder: '选择 Relation 显示方式' });
      if (choice) await vscode.workspace.getConfiguration('sourceInsightInspired').update('relationView', choice.value,
        vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    });
    this.command('focusReferences', () => this.referencesView.show());
    this.command('toggleSymbolKinds', () => vscode.workspace.getConfiguration('sourceInsightInspired').update('symbolKinds',
      this.symbols.allSymbols ? 'functions' : 'all', vscode.ConfigurationTarget.Workspace));
    this.command('findFile', () => this.pickers.files());
    this.command('browseSymbols', () => this.pickers.symbols(this.source()?.name || ''));
    this.command('jumpToDefinition', async node => {
      const source = this.source(node); if (!source) return;
      this.clearFollowTimer();
      const request = this.jumpGate.next();
      const locations = await this.language.definitions(source.uri, source.range.start);
      if (!this.jumpGate.current(request)) return;
      let chosen = locations[0];
      if (locations.length > 1) {
        /** @type {Array<import('vscode').QuickPickItem & {target: import('vscode').Location}>} */
        const choices = locations.map(location => ({
          label: `${vscode.workspace.asRelativePath(location.uri)}:${location.range.start.line + 1}`, target: location
        }));
        const choice = await vscode.window.showQuickPick(choices, { placeHolder: '选择定义位置', onDidSelectItem: item => {
          if (typeof item === 'object' && 'target' in item) this.run(() => this.preview.show(item.target));
        } });
        chosen = choice?.target;
      }
      if (!this.jumpGate.current(request)) return;
      if (chosen) await this.openTarget(chosen);
      else if (!locations.length) vscode.window.showInformationMessage('没有定义结果，请确认语言服务和工程配置。');
    });
    this.command('openSelection', view => {
      const tree = view === 'symbols' ? this.symbolView
        : view === 'relations' ? this.relationView : view === 'references' ? this.referencesView : undefined;
      const node = tree?.selection[0];
      if (tree && !node?.uri) return;
      return this.openTarget(node?.uri ? this.source(node) : this.preview.current);
    });
    this.command('contextMode', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: '智能定义', value: 'definition', description: '函数、标量和数组看定义，结构体等对象看类型' },
        { label: '类型定义', value: 'type', description: '查看变量的基础类型' },
        { label: '包含函数', value: 'enclosing', description: '固定查看当前函数的签名和开头' }
      ], { placeHolder: '选择 Context 自动跟随模式' });
      if (choice) await vscode.workspace.getConfiguration('sourceInsightInspired').update('contextMode', choice.value, vscode.ConfigurationTarget.Workspace);
    });
    this.command('filterReferences', async () => {
      const query = await vscode.window.showInputBox({ prompt: '按文件路径或源码包含的文字筛选（清空显示全部）', value: this.references.query });
      if (query !== undefined) await this.references.filter(query);
    });
    this.command('referenceHistory', async () => {
      const choice = await vscode.window.showQuickPick(this.references.recentSources.map(source => ({
        label: source.name || '符号', description: `${vscode.workspace.asRelativePath(source.uri)}:${source.range.start.line + 1}`, source
      })), { placeHolder: '选择最近查询的符号；将重新查询引用' });
      if (choice) await this.references.lookup(choice.source);
    });
    this.command('nextReference', () => this.moveReference(1));
    this.command('previousReference', () => this.moveReference(-1));
    this.command('open', async () => {
      await this.layout.apply();
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus');
      if (this.mainEditor) await this.reloadSymbols();
    });
    this.command('refreshSymbols', () => this.reloadSymbols());
    this.command('filterSymbols', async () => {
      const query = await vscode.window.showInputBox({ prompt: '按符号名或头文件名筛选（清空显示全部）', value: this.symbols.query });
      if (query === undefined) return;
      this.symbols.query = query; this.symbols.refresh(); this.syncSymbolDescription();
      await this.context.workspaceState.update('symbolQuery', query);
    });
    this.command('sortSymbols', async () => {
      const value = this.symbols.sort === 'position' ? 'name' : 'position';
      await vscode.workspace.getConfiguration('sourceInsightInspired').update('symbolSort', value, vscode.ConfigurationTarget.Workspace);
    });
    this.command('previewDefinition', async node => {
      const source = this.source(node); if (!source) return;
      this.clearFollowTimer();
      this.lastPreviewKey = undefined;
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus');
      await this.preview.definition(source);
    });
    this.command('previewType', async node => {
      const source = this.source(node); if (!source) return;
      this.clearFollowTimer();
      this.lastPreviewKey = undefined;
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus');
      await this.preview.definition(source, true);
    });
    this.command('previewFile', async node => {
      if (!node?.uri) return;
      this.clearFollowTimer();
      this.lastPreviewKey = undefined;
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus');
      await this.preview.show({ ...this.source(node), mode: '文件预览' });
    });
    this.command('openTarget', node => this.openTarget(node ? this.source(node) : this.preview.current));
    this.command('selectTarget', node => this.selectTarget(node));
    this.command('toggleContextLock', async () => {
      this.preview.toggleLock();
      if (!this.preview.locked) { this.lastPreviewKey = undefined; this.scheduleFollow(); }
    });
    this.preview.onNavigate = () => { this.clearFollowTimer(); this.lastPreviewKey = undefined; };
    this.preview.onLockChanged = locked => { if (!locked) { this.lastPreviewKey = undefined; this.scheduleFollow(); } };
    this.command('refreshContext', () => this.preview.refresh());
    this.command('incoming', node => this.setDirection('incoming', node));
    this.command('outgoing', node => this.setDirection('outgoing', node));
    this.command('setRoot', async node => {
      const source = this.source(node); if (!source) return;
      this.clearFollowTimer(); this.lastRelationKey = undefined;
      await this.relations.setRoot(source, true);
    });
    this.command('toggleRelationLock', () => {
      this.relations.locked = !this.relations.locked;
      this.relations.gate.invalidate(); this.relations.updateLabel();
      if (this.relations.locked && !this.relations.root) {
        this.relations.message = '已锁定，当前查询已取消；可刷新或解锁'; this.relations.refresh();
      }
      if (!this.relations.locked) { this.lastRelationKey = undefined; this.scheduleFollow(); }
    });
    this.command('refreshRelations', async () => {
      const source = this.relations.source || this.source();
      if (this.localIndex.enabled()) await this.localIndex.refresh();
      if (source) await this.relations.setRoot(source, true);
    });
    this.command('rebuildIndex', async () => {
      await this.localIndex.refresh(true);
      const source = this.relations.source || this.source();
      if (source) await this.relations.setRoot(source, true);
    });
    this.command('lookupReferences', async node => {
      const source = this.source(node); if (!source) return;
      this.referencesView.show();
      await this.references.lookup(source);
    });
    this.command('refreshReferences', () => this.references.source && this.references.lookup(this.references.source));
    this.command('clearReferences', () => this.references.clear());
    this.command('moreReferences', group => { group.shown += 200; this.references.refresh(group); });
    this.command('back', () => this.navigate('back'));
    this.command('forward', () => this.navigate('forward'));
  }

  registerEvents() {
    this.disposables.push(
      this.localIndex.onDidChange(() => {
        clearTimeout(this.relationTimer);
        this.relationTimer = setTimeout(() => this.run(async () => {
          const source = this.relations.source;
          if (source) await this.relations.setRoot(source, true);
        }), 150);
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => this.run(() => this.acceptEditor(editor))),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor !== this.mainEditor) return;
        const position = this.readingPosition();
        if (event.kind === vscode.TextEditorSelectionChangeKind.Command && !this.navigationDepth) {
          if (this.lastReadingPosition) this.history.push(this.lastReadingPosition);
          if (position) this.history.push(position);
        }
        this.lastReadingPosition = position;
        // Invalidate immediately; the old query must not win during the debounce interval.
        this.preview.invalidateAuto(); this.lastPreviewKey = undefined;
        if (!this.relations.locked) {
          const fn = sameUri(this.symbols.uri, event.textEditor.document.uri)
            ? enclosingFunction(this.symbols.nodes, event.textEditor.selection.active) : undefined;
          const next = this.relationSource(fn, this.source());
          if (next && locationKey(next) !== this.lastRelationKey) this.relations.gate.invalidate();
        }
        this.scheduleFollow();
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length) return;
        this.references.markStale(); this.relations.markStale(); this.lastRelationKey = undefined;
        this.lastPreviewKey = undefined;
        this.preview.invalidateAuto();
        if (sameUri(this.preview.current?.uri, event.document.uri)) {
          this.preview.current.stale = true;
          clearTimeout(this.previewTimer);
          this.previewTimer = setTimeout(() => this.run(() => this.preview.refresh()), 200);
        }
        if (sameUri(event.document.uri, this.mainEditor?.document.uri)) {
          this.symbols.invalidate(); clearTimeout(this.symbolTimer);
          this.symbolTimer = setTimeout(() => this.run(() => this.reloadSymbols()), this.config('debounceMs', 250));
        }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('workbench.colorTheme')) this.preview.publish();
        if (event.affectsConfiguration('sourceInsightInspired.relationView')) { this.run(() => this.relationView.publish()); return; }
        if (!event.affectsConfiguration('sourceInsightInspired') && !event.affectsConfiguration('files.exclude')) return;
        this.symbols.sort = this.config('symbolSort', 'position');
        this.symbols.allSymbols = this.config('symbolKinds', 'all') === 'all'; this.symbols.refresh(); this.syncSymbolDescription();
        if (event.affectsConfiguration('sourceInsightInspired.indexExclude')) this.run(() => this.localIndex.refresh());
        this.lastRelationKey = undefined; this.lastPreviewKey = undefined; this.scheduleFollow();
      }),
      this.symbolView.onDidChangeVisibility(event => { if (event.visible && this.mainEditor) this.run(() => this.reloadSymbols()); }),
      this.relationView.onDidChangeSelection(event => this.run(() => this.selectTarget(event.selection[0]))),
      this.symbolView.onDidChangeSelection(event => {
        if (!this.revealingSymbols) this.run(() => this.selectTarget(event.selection[0]));
      })
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const semanticChanged = uri => {
      if (/(?:^|\/)(?:\.git|\.cache|node_modules|build|dist|out|research)(?:\/|$)/.test(uri.path)) return;
      if (!/\.(?:c|h|cc|cpp|cxx|hpp|hxx|clangd)$/.test(uri.path) && !/compile_commands\.json$/.test(uri.path)) return;
      this.references.markStale(); this.relations.markStale();
    };
    this.disposables.push(watcher, watcher.onDidCreate(semanticChanged),
      watcher.onDidDelete(semanticChanged), watcher.onDidChange(semanticChanged));
  }

  syncSymbolDescription() {
    this.symbolView.description = `${this.symbols.allSymbols ? '全部符号' : '函数'} · ${this.symbols.sort === 'name' ? '名称排序' : '源码顺序'}${this.symbols.query ? ` · ${this.symbols.query}` : ''}`;
  }
  source(node) {
    if (node?.uri) return {
      uri: node.uri, range: node.selectionRange || node.range || new vscode.Range(0, 0, 0, 0), name: node.name
    };
    if (!this.mainEditor || this.mainEditor.document.isClosed) return;
    const editor = this.mainEditor;
    const position = editor.selection.active;
    const word = editor.document.getWordRangeAtPosition(position);
    return { uri: editor.document.uri, range: new vscode.Range(position, position),
      name: word ? editor.document.getText(word) : undefined };
  }
  readingPosition() {
    if (!this.mainEditor || this.mainEditor.document.isClosed) return;
    return { uri: this.mainEditor.document.uri,
      range: new vscode.Range(this.mainEditor.selection.start, this.mainEditor.selection.end) };
  }
  relationSource(fn, source) {
    if (!source || !this.mainEditor) return fn ? target(fn) : source;
    const document = this.mainEditor.document;
    const word = document.getWordRangeAtPosition(source.range.start);
    if (word) {
      const name = document.getText(word);
      const rest = document.lineAt(word.end.line).text.slice(word.end.character);
      if (/^\s*\(/.test(rest) && !/^(if|for|while|switch|sizeof|typeof|_Alignof)$/.test(name)) {
        return { ...source, range: word, name };
      }
    }
    return fn ? target(fn) : source;
  }
  clearFollowTimer() { clearTimeout(this.followTimer); this.followGate.invalidate(); }
  async acceptEditor(editor) {
    // Webview focus emits undefined; preserve the last main text editor.
    if (this.disposed || !editor || editor.document.isClosed || editor.document.uri.scheme === 'output') return;
    const changedFile = !sameUri(this.mainEditor?.document.uri, editor.document.uri);
    const previous = this.readingPosition();
    if (changedFile && previous && !this.navigationDepth) this.history.push(previous);
    this.mainEditor = editor;
    this.lastReadingPosition = this.readingPosition();
    if (changedFile && !this.navigationDepth) this.history.push(this.lastReadingPosition);
    if (changedFile) {
      this.mainGate.invalidate(); this.preview.invalidateAuto();
      if (!this.relations.locked) this.relations.gate.invalidate();
      this.lastRelationKey = undefined;
      await this.reloadSymbols();
    } else this.scheduleFollow();
  }
  async reloadSymbols() {
    if (this.disposed || !this.mainEditor || this.mainEditor.document.isClosed) return;
    const request = this.mainGate.next();
    const uri = this.mainEditor.document.uri;
    const valid = await this.symbols.load(uri);
    if (valid && this.mainGate.current(request)) { this.lastPreviewKey = undefined; this.scheduleFollow(); }
  }
  scheduleFollow() {
    if (this.disposed) return;
    this.clearFollowTimer();
    this.followTimer = setTimeout(() => this.run(() => this.follow()), this.config('debounceMs', 250));
  }
  async follow() {
    const request = this.followGate.next();
    const source = this.source(); if (!source) return;
    const nodesMatch = sameUri(this.symbols.uri, source.uri);
    const fn = nodesMatch ? enclosingFunction(this.symbols.nodes, source.range.start) : undefined;
    if (this.symbolView.visible) {
      const selected = fn && this.symbols.findDisplayed(locationKey(target(fn)));
      if (selected) {
        this.revealingSymbols++;
        try { await this.symbolView.reveal(selected, { select: true, focus: false, expand: true }); }
        finally { this.revealingSymbols--; }
      }
      else if (this.symbolView.selection.length) {
        // TreeView has no public clear-selection API; remove stale selection through a render reset.
        this.symbols.clearSelection();
      }
    }
    if (!this.followGate.current(request)) return;
    const tasks = [];
    if (this.config('autoPreview', true) && !this.preview.locked) {
      const document = this.mainEditor.document;
      const selectedWord = document.getWordRangeAtPosition(source.range.start);
      const word = selectedWord || source.range;
      const mode = this.config('contextMode', 'definition');
      const key = `${locationKey({ uri: source.uri, range: word })}@${document.version}:${mode}`;
      if (this.lastPreviewKey !== key && (selectedWord || mode === 'enclosing')) {
        this.lastPreviewKey = key;
        tasks.push(mode === 'enclosing' && fn
          ? this.preview.show({ ...target(fn), mode: '包含函数' }) : this.preview.definition({ ...source, range: word }, mode === 'type'));
      }
    }
    if (this.config('autoRelation', true) && !this.relations.locked) {
      const relationSource = this.relationSource(fn, source);
      const key = locationKey(relationSource);
      if (key !== this.lastRelationKey) {
        this.lastRelationKey = key;
        tasks.push(this.relations.setRoot(relationSource));
      }
    }
    await Promise.all(tasks);
  }
  async selectTarget(node) {
    if (!node?.uri || !['relation', 'reference', 'callsite', 'file', 'symbol'].includes(node.type)) return;
    if (node.type === 'reference') this.currentReference = node;
    this.clearFollowTimer(); this.preview.invalidateAuto();
    this.lastPreviewKey = undefined;
    const source = { ...this.source(node), mode: ['relation', 'symbol'].includes(node.type) ? '定义'
      : node.type === 'callsite' ? '调用现场' : node.type === 'file' ? '文件预览' : '引用现场' };
    await this.preview.show(source);
  }
  async moveReference(direction) {
    const rows = this.references.allVisibleReferences();
    if (!rows.length || this.references.stale) return;
    const current = this.currentReference ? rows.findIndex(row => locationKey(row) === locationKey(this.currentReference)) : -1;
    const index = current < 0 ? direction > 0 ? 0 : rows.length - 1 : (current + direction + rows.length) % rows.length;
    const row = rows[index];
    const group = this.references.visibleGroups.find(file => file.children.includes(row));
    row.parent = group; group.shown = Math.max(group.shown, group.children.indexOf(row) + 1);
    await this.selectTarget(row);
    this.references.refresh(group);
    await this.referencesView.reveal(row, { select: true, focus: false, expand: true });
  }
  async setDirection(direction, node) {
    this.clearFollowTimer();
    if (!node?.uri && this.relations.root) { this.relations.switchDirection(direction); return; }
    const source = node?.uri ? this.source(node) : this.relations.source || this.source();
    this.relations.direction = direction;
    this.relations.updateLabel();
    if (source) await this.relations.setRoot(source, true);
  }
  async openTarget(source, record = true) {
    if (!source) return;
    this.clearFollowTimer();
    this.jumpGate.invalidate(); this.preview.invalidateAuto();
    const request = this.navigationGate.next();
    this.lastPreviewKey = undefined;
    const origin = this.readingPosition();
    this.navigationDepth++;
    try {
      const document = await vscode.workspace.openTextDocument(source.uri);
      if (!this.navigationGate.current(request)) return;
      const range = document.validateRange(source.range);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: this.mainEditor?.viewColumn || vscode.ViewColumn.One,
        selection: range, preview: false, preserveFocus: false
      });
      if (!this.navigationGate.current(request)) return;
      this.mainEditor = editor;
      if (record && origin) this.history.push(origin);
      if (record) this.history.push({ ...source, range });
      await this.acceptEditor(editor);
      if (!sameUri(this.symbols.uri, source.uri)) await this.reloadSymbols();
    } finally {
      this.navigationDepth--;
      this.lastReadingPosition = this.readingPosition();
    }
  }

  async navigate(direction) {
    // Capture any manual movement since the last explicit jump before going back.
    if (direction === 'back') {
      const source = this.readingPosition(); if (source) this.history.push(source);
    }
    const destination = direction === 'back' ? this.history.back() : this.history.forward();
    if (destination) await this.openTarget(destination, false);
  }
  dispose() {
    this.disposed = true;
    this.mainGate.dispose();
    this.followGate.dispose();
    this.jumpGate.dispose();
    this.navigationGate.dispose();
    for (const timer of ['followTimer', 'symbolTimer', 'previewTimer', 'relationTimer']) clearTimeout(this[timer]);
    this.disposables.reverse().forEach(disposable => disposable.dispose());
  }
}

function activate(context) {
  const controller = new ReadingController(context);
  context.subscriptions.push(controller);
  return controller;
}

module.exports = { activate, ReadingController };
