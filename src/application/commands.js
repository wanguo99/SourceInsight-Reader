'use strict';
const { t } = require('../i18n');
const vscode = require('vscode');
const { enclosingFunction, locationKey } = require('../core');
const { manageReadingDirectories } = require('./reading-directories');
const { sameUri } = require('../resources');
const { errorText } = require('../trees');
const { manageCache } = require('../features/cache-manager');
function registerCommands(app) {
    app.commands.add('manageProjectSources', () => app.projectSources.show());
    app.commands.add('startIndex', () => app.projectSources.show());
    app.commands.add('manageCache', () => manageCache(app.context));
    app.commands.add('diagnostics', () => app.tools.diagnostics());
    app.commands.add('indexIssues', () => app.tools.indexIssues());
    app.commands.add('exportDiagnostics', () => app.tools.diagnostics(true));
    app.commands.add('keyboardPreset', () => app.tools.keyboardPreset());
    app.commands.add('configureClangd', () => app.clangdScope.configure());
    app.commands.add('restoreClangd', () => app.clangdScope.configure(false));
    app.commands.add('addBookmark', () => app.tools.addBookmark());
    app.commands.add('bookmarks', () => app.tools.bookmarks());
    app.commands.add('saveReadingTask', () => app.tools.saveTask());
    app.commands.add('restoreReadingTask', () => app.tools.restoreTask());
    app.commands.add('saveSearch', () => app.tools.savedSearch(true));
    app.commands.add('savedSearches', () => app.tools.savedSearch());
    app.commands.add('clearReadingData', () => app.tools.clearData());
    app.commands.add('exploreRelations', () => app.tools.explore());
    app.commands.add('pinContext', () => app.preview.pin());
    app.commands.add('welcome', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'wanguo.wanguo-sourceinsight-reader#sourceInsightReader.start', false));
    app.commands.add('excludeDirectory', context => app.fileSearchView.excludeDirectory(context));
    app.commands.add('manageReadingDirectories', () => manageReadingDirectories(app.catalog));
    app.commands.add('applyLayout', () => app.layout.apply());
    app.commands.add('restoreSidebar', () => app.layout.restore());
    app.commands.add('configureAppearance', () => app.appearancePanel.show('appearance'));
    app.commands.add('openSettings', () => app.appearancePanel.show('features'));
    app.commands.add('reloadWindow', () => vscode.commands.executeCommand('workbench.action.reloadWindow'));
    app.commands.add('focusSymbols', () => vscode.commands.executeCommand('sourceInsightReader.symbols.focus'));
    app.commands.add('focusContext', () => vscode.commands.executeCommand('sourceInsightReader.context.focus'));
    app.commands.add('focusRelations', async () => {
      await vscode.commands.executeCommand('sourceInsightReader.context.focus'); await app.relationView.focus();
    });
    app.commands.add('chooseRelationView', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: t('横向关系图'), description: t('调用者 → 当前函数 → 调用函数，各一层'), value: 'horizontalGraph' },
        { label: t('树形列表'), description: t('保留原有 Outline，多级展开并切换调用方向'), value: 'outline' }
      ], { placeHolder: t('选择 Relation 显示方式') });
      if (choice) await vscode.workspace.getConfiguration('sourceInsightReader').update('relationView', choice.value,
        vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    });
    app.commands.add('toggleSymbolHighlight', requested => {
      const active = vscode.window.activeTextEditor;
      const editor = active && !active.document.isClosed && active.document.uri.scheme !== 'output' ? active : app.session.editor;
      const selected = editor?.document.getText(editor.selection).trim();
      const word = editor?.document.getWordRangeAtPosition(editor.selection.active);
      const symbol = typeof requested === 'string' && requested ? requested.trim()
        : selected || (word ? editor.document.getText(word) : '');
      if (!app.symbolHighlight.toggle(symbol)) {
        vscode.window.showInformationMessage(t('请先选中一个完整符号，或将光标放在符号名称上')); return;
      }
      const message = app.symbolHighlight.symbol ? `同名高亮：${symbol} · 当前可见编辑器 ${app.symbolHighlight.count} 处（再次按 F2 或 Ctrl+Alt+H 取消）` : t('已取消固定符号高亮');
      app.output.appendLine(message);
      vscode.window.setStatusBarMessage(message, 5000);
    });
    app.commands.add('clearSymbolHighlight', () => {
      app.symbolHighlight.clear(); vscode.window.setStatusBarMessage(t('已清除固定符号高亮'), 3000);
    });
    app.commands.add('focusReferences', () => app.searchResultsView.show('references'));
    app.commands.add('toggleSymbolKinds', () => vscode.workspace.getConfiguration('sourceInsightReader').update('symbolKinds',
      app.symbols.allSymbols ? 'functions' : 'all', vscode.ConfigurationTarget.Workspace));
    app.commands.add('findFile', () => app.pickers.files());
    app.commands.add('browseSymbols', () => app.pickers.symbols(app.navigation.source()?.name || ''));
    app.commands.add('jumpToDefinition', async node => {
      const source = app.navigation.source(node); if (!source) return;
      app.follow.cancel();
      const request = app.navigation.jumpGate.next();
      const locations = await app.language.definitions(source.uri, source.range.start);
      if (!app.navigation.jumpGate.current(request)) return;
      let chosen = locations[0];
      if (locations.length > 1) {
        /** @type {Array<import('vscode').QuickPickItem & {target: import('vscode').Location}>} */
        const choices = locations.map(location => ({
          label: `${vscode.workspace.asRelativePath(location.uri)}:${location.range.start.line + 1}`, target: location
        }));
        const choice = await vscode.window.showQuickPick(choices, { placeHolder: t('选择定义位置'), onDidSelectItem: item => {
          if (typeof item === 'object' && 'target' in item) app.run(() => app.preview.show(item.target));
        } });
        chosen = choice?.target;
      }
      if (!app.navigation.jumpGate.current(request)) return;
      if (chosen) await app.navigation.openTarget(chosen);
      else if (!locations.length) vscode.window.showInformationMessage(t('没有定义结果，请确认语言服务和工程配置。'));
    });
    app.commands.add('openSelection', view => {
      const tree = view === 'symbols' ? app.symbolView
        : view === 'relations' ? app.relationView : view === 'references' ? app.referenceSession : undefined;
      const node = tree?.selection[0];
      if (tree && !node?.uri) return;
      return app.navigation.openTarget(node?.uri ? app.navigation.source(node) : app.preview.current);
    });
    app.commands.add('contextMode', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: t('定义或声明'), value: 'definition', description: t('查看当前符号自身的位置；变量和字段不自动跳到类型') },
        { label: t('类型定义'), value: 'type', description: t('查看变量的基础类型') },
        { label: t('包含函数'), value: 'enclosing', description: t('固定查看当前函数的签名和开头') }
      ], { placeHolder: t('选择 Context 自动跟随模式') });
      if (choice) await vscode.workspace.getConfiguration('sourceInsightReader').update('contextMode', choice.value, vscode.ConfigurationTarget.Workspace);
    });
    app.commands.add('filterReferences', async () => {
      const query = await vscode.window.showInputBox({ prompt: t('按文件路径或源码包含的文字筛选（清空显示全部）'), value: app.references.query });
      if (query !== undefined) await app.references.filter(query);
    });
    app.commands.add('referenceHistory', async () => {
      /** @type {any} */
      const choice = await vscode.window.showQuickPick(app.references.recentSources.map(source => ({
        label: source.name || t('符号'), description: `${vscode.workspace.asRelativePath(source.uri)}:${source.range.start.line + 1}`, source
      })), { placeHolder: t('选择最近查询的符号；将重新查询引用') });
      if (choice) await app.references.lookup(choice.source);
    });
    app.commands.add('nextReference', () => app.searchResultsView.move(1));
    app.commands.add('previousReference', () => app.searchResultsView.move(-1));
    app.commands.add('nextTextMatch', () => app.textSession.move(1));
    app.commands.add('previousTextMatch', () => app.textSession.move(-1));
    app.commands.add('lookupText', async node => {
      const source = app.navigation.source(node);
      const selection = !node && app.session.editor ? app.session.editor.document.getText(app.session.editor.selection) : '';
      const query = node?.name || (selection && !/[\r\n]/.test(selection) ? selection : source?.name || '');
      await app.searchResultsView.launchText(query, source?.uri);
    });
    app.commands.add('focusTextLookup', () => app.searchResultsView.show('text'));
    app.commands.add('open', async () => {
      await app.layout.apply();
      await vscode.commands.executeCommand('sourceInsightReader.context.focus');
      if (app.session.editor) await app.follow.reloadSymbols();
    });
    app.commands.add('focusFileSearch', () => app.fileSearchView.focus());
    app.commands.add('refreshFileSearch', () => app.fileSearchView.refresh());
    app.commands.add('refreshSymbols', () => app.follow.reloadSymbols());
    app.commands.add('filterSymbols', () => app.symbolView.focusSearch());
    app.commands.add('sortSymbols', async () => {
      const value = app.symbols.sort === 'position' ? 'name' : 'position';
      await vscode.workspace.getConfiguration('sourceInsightReader').update('symbolSort', value, vscode.ConfigurationTarget.Workspace);
    });
    app.commands.add('previewDefinition', async node => {
      const source = app.navigation.source(node); if (!source) return;
      app.follow.cancel();
      app.session.previewKey = undefined;
      await vscode.commands.executeCommand('sourceInsightReader.context.focus');
      await app.preview.definition(source);
    });
    app.commands.add('previewType', async node => {
      const source = app.navigation.source(node); if (!source) return;
      app.follow.cancel();
      app.session.previewKey = undefined;
      await vscode.commands.executeCommand('sourceInsightReader.context.focus');
      await app.preview.definition(source, true);
    });
    app.commands.add('previewFile', async node => {
      if (!node?.uri) return;
      app.follow.cancel();
      app.session.previewKey = undefined;
      await vscode.commands.executeCommand('sourceInsightReader.context.focus');
      await app.preview.show({ ...app.navigation.source(node), mode: t('文件预览') });
    });
    app.commands.add('openTarget', node => app.navigation.openTarget(node ? app.navigation.source(node) : app.preview.current));
    app.commands.add('selectTarget', node => app.navigation.selectTarget(node));
    app.commands.add('toggleContextLock', async () => {
      app.preview.toggleLock();
      if (!app.preview.locked) { app.session.previewKey = undefined; app.follow.schedule(); }
    });
    app.preview.onNavigate = () => { app.follow.cancel(); app.session.previewKey = undefined; };
    app.preview.onLockChanged = locked => { if (!locked) { app.session.previewKey = undefined; app.follow.schedule(); } };
    app.commands.add('refreshContext', () => app.preview.refresh());
    app.commands.add('incoming', node => app.navigation.setDirection('incoming', node));
    app.commands.add('outgoing', node => app.navigation.setDirection('outgoing', node));
    app.commands.add('setRoot', async node => {
      const source = app.navigation.source(node); if (!source) return;
      app.follow.cancel(); app.session.relationKey = undefined;
      await app.relations.setRoot(source, { manual: true, interactive: true });
    });
    app.commands.add('toggleRelationLock', () => { app.relations.toggleLock(); if (!app.relations.locked) { app.session.relationKey = undefined; app.follow.schedule(); } });
    app.commands.add('verifyRelations', () => app.relations.verify());
    app.commands.add('refreshRelations', () => app.relations.refresh());
    app.commands.add('rebuildIndex', async () => {
      app.projectSources.show();
    });
    app.commands.add('lookupReferences', async node => {
      const source = app.navigation.source(node); if (!source) return;
      app.searchResultsView.show('references');
      await app.references.lookup(source);
    });
    app.commands.add('refreshReferences', () => app.references.source && app.references.lookup(app.references.source));
    app.commands.add('clearReferences', () => app.references.clear());
    app.commands.add('back', () => app.navigation.navigate('back'));
    app.commands.add('forward', () => app.navigation.navigate('forward'));
  }
module.exports = { registerCommands };
