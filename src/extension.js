'use strict';
const { SymbolHighlight } = require('./symbol-highlight');
const { SearchResultsView } = require('./search-results-view');
const vscode = require('vscode');
const { createRelationBackend } = require('./providers/create-relation-backend');
const { LanguageAdapter } = require('./language');
const { SymbolTree, ReferencesTree, target, errorText } = require('./trees');
const { ContextView } = require('./context');
const { ReadingPanel } = require('./features/reading-panel');
const { TextSearchSession, ReferenceSearchSession } = require('./features/search-sessions');
const { TextLookup } = require('./text-lookup');
const { ReadingPickers } = require('./pickers');
const { ReadingLayout } = require('./layout');
const { RelationPane } = require('./relation-pane');
const { RelationSession } = require('./features/relation-session');
const { LocalIndex } = require('./local-index');
const { WorkspaceFileCatalog } = require('./infrastructure/workspace-file-catalog');
const { SymbolView } = require('./symbol-view');
const { FileSearchView } = require('./file-search');
const { registerLocalDefinitions } = require('./definition-provider');

const { ReadingSession } = require('./application/reading-session');
const { NavigationService } = require('./application/navigation-service');
const { FollowController } = require('./application/follow-controller');
const { CommandRegistry } = require('./application/command-registry');
const { registerCommands } = require('./application/commands');
const { connectEvents } = require('./application/events');

class ReadingController {
  constructor(context) {
    this.disposed = false;
    this.context = context;
    this.disposables = [];
    this.session = new ReadingSession();
    this.output = vscode.window.createOutputChannel('Source Insight Inspired');
    this.catalog = new WorkspaceFileCatalog(); this.disposables.push(this.catalog);
    this.localIndex = new LocalIndex(context, this.catalog, message => this.output.appendLine(message));
    this.language = new LanguageAdapter(this.localIndex);
    this.relationEngine = createRelationBackend(this.localIndex, this.catalog); this.disposables.push(this.relationEngine);
    this.disposables.push(this.localIndex, registerLocalDefinitions(this.localIndex));
    this.layout = new ReadingLayout(context);
    this.symbols = new SymbolTree(this.language);
    this.symbols.query = context.workspaceState.get('symbolQuery', '');
    this.symbols.sort = vscode.workspace.getConfiguration('sourceInsightInspired').get('symbolSort', 'position');
    this.symbols.allSymbols = vscode.workspace.getConfiguration('sourceInsightInspired').get('symbolKinds', String('all')) === 'all';
    this.symbols.refresh();
    this.relations = new RelationSession(this.relationEngine, async values => {
      /** @type {Array<{label:string,description:string,symbol:any}>} */
      const choices = values.map(symbol => ({ label: symbol.name, description: symbol.location.uri, symbol }));
      return (await vscode.window.showQuickPick(choices, { placeHolder: '选择调用关系根节点' }))?.symbol;
    });
    // A lock without its target is not restored across reloads.
    this.references = new ReferencesTree(this.language, () => {
      this.run(() => vscode.commands.executeCommand('setContext', 'sourceInsightInspired.hasReferences', Boolean(this.references.visibleGroups.length && !this.references.stale)));
    });
    this.preview = new ContextView(this.language, source => this.navigation.openTarget(source));
    this.symbolHighlight = new SymbolHighlight(symbol => { this.preview.highlightSymbol = symbol; this.preview.publish(); }, context.workspaceState, error => { this.run(() => { throw error; }, true); });
    this.disposables.push(this.symbolHighlight);
    this.preview.onHighlightSymbol = symbol => this.run(() => vscode.commands.executeCommand('sourceInsightInspired.toggleSymbolHighlight', symbol));
    this.pickers = new ReadingPickers(this.language, source => this.navigation.openTarget(source), async source => {
      this.follow.cancel(); this.session.previewKey = undefined; await this.preview.show(source);
    }, error => this.run(() => { throw error; }, true));
    this.symbolView = new SymbolView(context.extensionUri, this.symbols, node => this.navigation.openTarget(this.navigation.source(node)),
      async query => {
        this.symbols.query = query; this.symbols.refresh(); this.follow.syncSymbolDescription();
        await this.context.workspaceState.update('symbolQuery', query);
      }, error => this.run(() => { throw error; }, true));
    this.fileSearchView = new FileSearchView(context, this.catalog, source => this.navigation.openTarget(source),
      error => this.run(() => { throw error; }, true));
    this.relationView = new RelationPane(this.relations, () => this.readingPanel?.port,
      node => this.navigation.openTarget(node), error => this.run(() => { throw error; }, true));
    this.readingPanel = new ReadingPanel(context.extensionUri, this.preview, this.relationView, error => this.run(() => { throw error; }, true), this.localIndex);
    this.textLookup = new TextLookup(this.catalog, async uri => this.localIndex.summary && this.localIndex.enabled() && this.localIndex.supports(uri) ? this.localIndex.symbols(uri) : []);
    this.textSession = new TextSearchSession(this.textLookup, this.catalog, (row, pinned) => this.navigation.openTarget(row, true, !pinned), row => this.navigation.selectTarget(row));
    this.referenceSession = new ReferenceSearchSession(this.references, (row, pinned) => this.navigation.openTarget(row, true, !pinned), row => this.navigation.selectTarget(row), () => vscode.commands.executeCommand('sourceInsightInspired.referenceHistory'));
    this.searchResultsView = new SearchResultsView(context.extensionUri, { text: this.textSession, references: this.referenceSession }, error => this.run(() => { throw error; }, true));
    this.disposables.push(this.searchResultsView, this.textSession, this.referenceSession,
      vscode.window.registerWebviewViewProvider('sourceInsightInspired.searchResults', this.searchResultsView, { webviewOptions: { retainContextWhenHidden: true } }));
    this.disposables.push(this.textLookup, this.textLookup.onDidChange(() => {
      const has = Boolean(this.textLookup.rows.length && !this.textLookup.busy && !this.textLookup.stale);
      if (this.hasTextMatches !== has) {
        this.hasTextMatches = has; this.run(() => vscode.commands.executeCommand('setContext', 'sourceInsightInspired.hasTextMatches', has));
      }
    }));
    this.disposables.push(this.output, this.symbols, this.relations, this.references,
      this.preview, this.readingPanel, this.pickers, this.fileSearchView, this.symbolView, this.relationView,
      vscode.window.registerWebviewViewProvider('sourceInsightInspired.files', this.fileSearchView),
      vscode.window.registerWebviewViewProvider('sourceInsightInspired.symbols', this.symbolView),
      vscode.window.registerWebviewViewProvider('sourceInsightInspired.context', this.readingPanel));
    this.commands = new CommandRegistry(this.disposables, (action, notify) => this.run(action, notify));
    this.navigation = new NavigationService({ session: this.session, language: this.language, preview: this.preview,
      symbols: this.symbols, references: this.references, referenceSession: this.referenceSession, relations: this.relations });
    this.follow = new FollowController({ session: this.session, symbols: this.symbols, symbolView: this.symbolView,
      fileSearchView: this.fileSearchView, preview: this.preview, relations: this.relations, navigation: this.navigation,
      config: (name, fallback) => this.config(name, fallback), run: action => this.run(action) });
    this.navigation.follow = this.follow;
    this.disposables.push(this.navigation, this.follow);
    registerCommands(this); connectEvents(this);
    this.follow.syncSymbolDescription();
    this.run(() => this.layout.initialize());
    this.run(() => this.follow.acceptEditor(vscode.window.activeTextEditor));
  }
  run(action, notify = false) {
    return Promise.resolve().then(() => { if (!this.disposed) return action(); }).catch(error => {
      if (this.disposed) return;
      this.output.appendLine(`${new Date().toISOString()} ${errorText(error)}`);
      if (notify) vscode.window.showErrorMessage(`Source Insight Inspired：${errorText(error)}`);
    });
  }
  config(name, fallback) {
    return vscode.workspace.getConfiguration('sourceInsightInspired', this.session.editor?.document.uri).get(name, fallback);
  }
  dispose() {
    this.disposed = true;
    for (const timer of ['symbolTimer', 'previewTimer', 'relationTimer']) clearTimeout(this[timer]);
    this.disposables.reverse().forEach(disposable => disposable.dispose());
  }
}
function activate(context) {
  const controller = new ReadingController(context); context.subscriptions.push(controller); return controller;
}
module.exports = { activate, ReadingController };
