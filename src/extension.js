'use strict';
const vscode = require('vscode');
const { LanguageAdapter } = require('./language');
const { FileTree, SymbolTree, RelationTree, ReferencesTree, target, errorText } = require('./trees');
const { ContextView } = require('./context');
const { NavigationHistory, RequestGate, enclosingFunction, locationKey } = require('./core');

class ReadingController {
  constructor(context) {
    this.disposed = false;
    this.context = context;
    this.disposables = [];
    this.mainGate = new RequestGate();
    this.followGate = new RequestGate();
    this.history = new NavigationHistory();
    this.language = new LanguageAdapter();
    this.output = vscode.window.createOutputChannel('Source Reader');
    this.files = new FileTree();
    this.symbols = new SymbolTree(this.language);
    this.symbols.query = context.workspaceState.get('symbolQuery', '');
    this.symbols.sort = vscode.workspace.getConfiguration('sourceReader').get('symbolSort', 'position');
    this.relations = new RelationTree(this.language, description => { this.relationView.description = description; });
    // A lock without its target is not restored across reloads.
    this.references = new ReferencesTree(this.language, description => {
      this.referencesView.description = description;
      const source = this.references.source;
      this.referencesView.message = source ? `${vscode.workspace.asRelativePath(source.uri)}:${source.range.start.line + 1}` : undefined;
    });
    this.preview = new ContextView(context.extensionUri, this.language, source => this.openTarget(source));
    this.fileView = vscode.window.createTreeView('sourceReader.files', { treeDataProvider: this.files, showCollapseAll: true });
    this.symbolView = vscode.window.createTreeView('sourceReader.symbols', { treeDataProvider: this.symbols, showCollapseAll: true });
    this.relationView = vscode.window.createTreeView('sourceReader.relations', { treeDataProvider: this.relations, showCollapseAll: true });
    this.referencesView = vscode.window.createTreeView('sourceReader.references', { treeDataProvider: this.references, showCollapseAll: true });
    this.disposables.push(this.output, this.files, this.symbols, this.relations, this.references,
      this.preview, this.fileView, this.symbolView, this.relationView, this.referencesView,
      vscode.window.registerWebviewViewProvider('sourceReader.context', this.preview));
    this.registerCommands();
    this.registerEvents();
    this.relations.updateLabel();
    this.syncSymbolDescription();
    this.run(() => this.acceptEditor(vscode.window.activeTextEditor));
  }

  run(action, notify = false) {
    return Promise.resolve().then(() => { if (!this.disposed) return action(); }).catch(error => {
      if (this.disposed) return;
      this.output.appendLine(`${new Date().toISOString()} ${errorText(error)}`);
      if (notify) vscode.window.showErrorMessage(`Source Reader：${errorText(error)}`);
    });
  }
  command(name, action) {
    this.disposables.push(vscode.commands.registerCommand(`sourceReader.${name}`, (...args) => this.run(() => action(...args), true)));
  }
  config(name, fallback) {
    return vscode.workspace.getConfiguration('sourceReader', this.mainEditor?.document.uri).get(name, fallback);
  }

  registerCommands() {
    this.command('open', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.sourceReader');
      await vscode.commands.executeCommand('sourceReader.context.focus');
      if (this.mainEditor) await this.reloadSymbols();
    });
    this.command('refreshFiles', () => this.files.refresh());
    this.command('revealFile', async () => {
      if (!this.mainEditor) return;
      const node = await this.files.find(this.mainEditor.document.uri);
      if (node) await this.fileView.reveal(node, { select: true, focus: false, expand: true });
    });
    this.command('refreshSymbols', () => this.reloadSymbols());
    this.command('filterSymbols', async () => {
      const query = await vscode.window.showInputBox({ prompt: '按函数名筛选（清空显示全部）', value: this.symbols.query });
      if (query === undefined) return;
      this.symbols.query = query; this.symbols.refresh(); this.syncSymbolDescription();
      await this.context.workspaceState.update('symbolQuery', query);
    });
    this.command('sortSymbols', async () => {
      const value = this.symbols.sort === 'position' ? 'name' : 'position';
      await vscode.workspace.getConfiguration('sourceReader').update('symbolSort', value, vscode.ConfigurationTarget.Workspace);
    });
    this.command('previewDefinition', async node => {
      const source = this.source(node); if (!source) return;
      this.clearFollowTimer();
      this.lastPreviewKey = undefined;
      await vscode.commands.executeCommand('sourceReader.context.focus');
      await this.preview.definition(source);
    });
    this.command('previewType', async node => {
      const source = this.source(node); if (!source) return;
      this.clearFollowTimer();
      this.lastPreviewKey = undefined;
      await vscode.commands.executeCommand('sourceReader.context.focus');
      await this.preview.definition(source, true);
    });
    this.command('previewFile', async node => {
      if (!node?.uri) return;
      this.clearFollowTimer();
      this.lastPreviewKey = undefined;
      await vscode.commands.executeCommand('sourceReader.context.focus');
      await this.preview.show({ ...this.source(node), mode: '文件预览' });
    });
    this.command('openTarget', node => this.openTarget(node ? this.source(node) : this.preview.current));
    this.command('selectTarget', node => this.selectTarget(node));
    this.command('toggleContextLock', async () => {
      this.preview.toggleLock();
      if (!this.preview.locked) { this.lastPreviewKey = undefined; this.scheduleFollow(); }
    });
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
      if (source) await this.relations.setRoot(source, true);
    });
    this.command('lookupReferences', async node => {
      const source = this.source(node); if (!source) return;
      await vscode.commands.executeCommand('sourceReader.references.focus');
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
      vscode.window.onDidChangeActiveTextEditor(editor => this.run(() => this.acceptEditor(editor))),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor !== this.mainEditor) return;
        // Invalidate immediately; the old query must not win during the debounce interval.
        this.preview.invalidateAuto();
        if (!this.relations.locked) {
          const fn = this.symbols.uri?.toString() === event.textEditor.document.uri.toString()
            ? enclosingFunction(this.symbols.nodes, event.textEditor.selection.active) : undefined;
          const next = fn ? target(fn) : this.source();
          if (next && locationKey(next) !== this.lastRelationKey) this.relations.gate.invalidate();
        }
        this.scheduleFollow();
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length) return;
        this.references.markStale(); this.relations.markStale(); this.lastRelationKey = undefined;
        this.lastPreviewKey = undefined;
        this.preview.invalidateAuto();
        if (this.preview.current?.uri.toString() === event.document.uri.toString()) {
          this.preview.current.stale = true;
          clearTimeout(this.previewTimer);
          this.previewTimer = setTimeout(() => this.run(() => this.preview.refresh()), 200);
        }
        if (event.document.uri.toString() === this.mainEditor?.document.uri.toString()) {
          this.symbols.invalidate(); clearTimeout(this.symbolTimer);
          this.symbolTimer = setTimeout(() => this.run(() => this.reloadSymbols()), this.config('debounceMs', 250));
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.files.refresh()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('sourceReader') && !event.affectsConfiguration('files.exclude')) return;
        this.files.refresh();
        this.symbols.sort = this.config('symbolSort', 'position'); this.symbols.refresh(); this.syncSymbolDescription();
        this.lastRelationKey = undefined; this.lastPreviewKey = undefined; this.scheduleFollow();
      }),
      this.symbolView.onDidChangeVisibility(event => { if (event.visible && this.mainEditor) this.run(() => this.reloadSymbols()); }),
      this.relationView.onDidChangeSelection(event => this.run(() => this.selectTarget(event.selection[0]))),
      this.referencesView.onDidChangeSelection(event => this.run(() => this.selectTarget(event.selection[0])))
    );
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const changed = () => {
      clearTimeout(this.fileTimer);
      this.fileTimer = setTimeout(() => this.files.refresh(), 150);
    };
    this.disposables.push(watcher, watcher.onDidCreate(changed), watcher.onDidDelete(() => {
      changed(); this.references.markStale(); this.relations.markStale();
    }), watcher.onDidChange(() => { this.references.markStale(); this.relations.markStale(); }));
  }

  syncSymbolDescription() {
    this.symbolView.description = `${this.symbols.sort === 'name' ? '名称排序' : '源码顺序'}${this.symbols.query ? ` · ${this.symbols.query}` : ''}`;
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
  clearFollowTimer() { clearTimeout(this.followTimer); this.followGate.invalidate(); }
  async acceptEditor(editor) {
    // Webview focus emits undefined; preserve the last main text editor.
    if (this.disposed || !editor || editor.document.uri.scheme === 'output') return;
    const changedFile = this.mainEditor?.document.uri.toString() !== editor.document.uri.toString();
    this.mainEditor = editor;
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
    if (valid && this.mainGate.current(request)) this.scheduleFollow();
  }
  scheduleFollow() {
    if (this.disposed) return;
    this.clearFollowTimer();
    this.followTimer = setTimeout(() => this.run(() => this.follow()), this.config('debounceMs', 250));
  }
  async follow() {
    const request = this.followGate.next();
    const source = this.source(); if (!source) return;
    const nodesMatch = this.symbols.uri?.toString() === source.uri.toString();
    const fn = nodesMatch ? enclosingFunction(this.symbols.nodes, source.range.start) : undefined;
    if (this.symbolView.visible) {
      const selected = fn && this.symbols.findDisplayed(locationKey(target(fn)));
      if (selected) await this.symbolView.reveal(selected, { select: true, focus: false, expand: true });
      else if (this.symbolView.selection.length) {
        // TreeView has no public clear-selection API; remove stale selection through a render reset.
        this.symbols.clearSelection();
      }
    }
    if (!this.followGate.current(request)) return;
    const tasks = [];
    if (this.config('autoPreview', true) && !this.preview.locked) {
      const document = this.mainEditor.document;
      const word = document.getWordRangeAtPosition(source.range.start) || source.range;
      const key = `${locationKey({ uri: source.uri, range: word })}@${document.version}`;
      if (this.lastPreviewKey !== key) {
        this.lastPreviewKey = key;
        tasks.push(this.preview.definition(source));
      }
    }
    if (this.config('autoRelation', true) && !this.relations.locked) {
      const relationSource = fn ? target(fn) : source;
      const key = locationKey(relationSource);
      if (key !== this.lastRelationKey) {
        this.lastRelationKey = key;
        tasks.push(this.relations.setRoot(relationSource));
      }
    }
    await Promise.all(tasks);
  }
  async selectTarget(node) {
    if (!node?.uri || !['relation', 'reference', 'callsite'].includes(node.type)) return;
    this.clearFollowTimer(); this.preview.invalidateAuto();
    this.lastPreviewKey = undefined;
    const source = { ...this.source(node), mode: node.type === 'relation' ? '定义' : node.type === 'callsite' ? '调用现场' : '引用现场' };
    await this.preview.show(source);
  }
  async setDirection(direction, node) {
    this.clearFollowTimer();
    const source = node?.uri ? this.source(node) : this.relations.source || this.source();
    this.relations.direction = direction;
    this.relations.updateLabel();
    if (source) await this.relations.setRoot(source, true);
  }
  async openTarget(source, record = true) {
    if (!source) return;
    this.clearFollowTimer();
    this.lastPreviewKey = undefined;
    const origin = this.readingPosition();
    if (record && origin) this.history.push(origin);
    const document = await vscode.workspace.openTextDocument(source.uri);
    const range = document.validateRange(source.range);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: this.mainEditor?.viewColumn || vscode.ViewColumn.One,
      selection: range, preview: false, preserveFocus: false
    });
    this.mainEditor = editor;
    if (record) this.history.push({ ...source, range });
    await this.acceptEditor(editor);
    if (this.symbols.uri?.toString() !== source.uri.toString()) await this.reloadSymbols();
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
    for (const timer of ['followTimer', 'symbolTimer', 'fileTimer', 'previewTimer']) clearTimeout(this[timer]);
    this.disposables.reverse().forEach(disposable => disposable.dispose());
  }
}

function activate(context) {
  const controller = new ReadingController(context);
  context.subscriptions.push(controller);
  return controller;
}

module.exports = { activate, ReadingController };
