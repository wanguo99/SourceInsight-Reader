'use strict';
const vscode = require('vscode');
const { enclosingFunction, locationKey } = require('../core');
const { sameUri } = require('../resources');
const { errorText } = require('../trees');
function registerCommands(app) {
    app.commands.add('applyLayout', () => app.layout.apply());
    app.commands.add('restoreSidebar', () => app.layout.restore());
    app.commands.add('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-dev.source-insight-inspired'));
    app.commands.add('focusSymbols', () => vscode.commands.executeCommand('sourceInsightInspired.symbols.focus'));
    app.commands.add('focusContext', () => vscode.commands.executeCommand('sourceInsightInspired.context.focus'));
    app.commands.add('focusRelations', async () => {
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus'); await app.relationView.focus();
    });
    app.commands.add('chooseRelationView', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: '横向关系图', description: '调用者 → 当前函数 → 调用函数，各一层', value: 'horizontalGraph' },
        { label: '树形列表', description: '保留原有 Outline，多级展开并切换调用方向', value: 'outline' }
      ], { placeHolder: '选择 Relation 显示方式' });
      if (choice) await vscode.workspace.getConfiguration('sourceInsightInspired').update('relationView', choice.value,
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
        vscode.window.showInformationMessage('请先选中一个完整符号，或将光标放在符号名称上'); return;
      }
      const message = app.symbolHighlight.symbol ? `同名高亮：${symbol} · 当前可见编辑器 ${app.symbolHighlight.count} 处（再次按 F2 或 Ctrl+Alt+H 取消）` : '已取消固定符号高亮';
      app.output.appendLine(message);
      vscode.window.setStatusBarMessage(message, 5000);
    });
    app.commands.add('clearSymbolHighlight', () => {
      app.symbolHighlight.clear(); vscode.window.setStatusBarMessage('已清除固定符号高亮', 3000);
    });
    app.commands.add('focusReferences', () => app.searchResultsView.show('references'));
    app.commands.add('toggleSymbolKinds', () => vscode.workspace.getConfiguration('sourceInsightInspired').update('symbolKinds',
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
        const choice = await vscode.window.showQuickPick(choices, { placeHolder: '选择定义位置', onDidSelectItem: item => {
          if (typeof item === 'object' && 'target' in item) app.run(() => app.preview.show(item.target));
        } });
        chosen = choice?.target;
      }
      if (!app.navigation.jumpGate.current(request)) return;
      if (chosen) await app.navigation.openTarget(chosen);
      else if (!locations.length) vscode.window.showInformationMessage('没有定义结果，请确认语言服务和工程配置。');
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
        { label: '智能定义', value: 'definition', description: '函数、标量和数组看定义，结构体等对象看类型' },
        { label: '类型定义', value: 'type', description: '查看变量的基础类型' },
        { label: '包含函数', value: 'enclosing', description: '固定查看当前函数的签名和开头' }
      ], { placeHolder: '选择 Context 自动跟随模式' });
      if (choice) await vscode.workspace.getConfiguration('sourceInsightInspired').update('contextMode', choice.value, vscode.ConfigurationTarget.Workspace);
    });
    app.commands.add('filterReferences', async () => {
      const query = await vscode.window.showInputBox({ prompt: '按文件路径或源码包含的文字筛选（清空显示全部）', value: app.references.query });
      if (query !== undefined) await app.references.filter(query);
    });
    app.commands.add('referenceHistory', async () => {
      /** @type {any} */
      const choice = await vscode.window.showQuickPick(app.references.recentSources.map(source => ({
        label: source.name || '符号', description: `${vscode.workspace.asRelativePath(source.uri)}:${source.range.start.line + 1}`, source
      })), { placeHolder: '选择最近查询的符号；将重新查询引用' });
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
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus');
      if (app.session.editor) await app.follow.reloadSymbols();
    });
    app.commands.add('focusFileSearch', () => app.fileSearchView.focus());
    app.commands.add('refreshFileSearch', () => app.fileSearchView.refresh());
    app.commands.add('refreshSymbols', () => app.follow.reloadSymbols());
    app.commands.add('filterSymbols', () => app.symbolView.focusSearch());
    app.commands.add('sortSymbols', async () => {
      const value = app.symbols.sort === 'position' ? 'name' : 'position';
      await vscode.workspace.getConfiguration('sourceInsightInspired').update('symbolSort', value, vscode.ConfigurationTarget.Workspace);
    });
    app.commands.add('previewDefinition', async node => {
      const source = app.navigation.source(node); if (!source) return;
      app.follow.cancel();
      app.session.previewKey = undefined;
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus');
      await app.preview.definition(source);
    });
    app.commands.add('previewType', async node => {
      const source = app.navigation.source(node); if (!source) return;
      app.follow.cancel();
      app.session.previewKey = undefined;
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus');
      await app.preview.definition(source, true);
    });
    app.commands.add('previewFile', async node => {
      if (!node?.uri) return;
      app.follow.cancel();
      app.session.previewKey = undefined;
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus');
      await app.preview.show({ ...app.navigation.source(node), mode: '文件预览' });
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
    app.commands.add('refreshRelations', () => app.relations.refresh());
    app.commands.add('rebuildIndex', async () => {
      await app.localIndex.refresh(true);
      const source = app.relations.source || app.navigation.source();
      if (source) await app.relations.setRoot(source, { manual: true, interactive: true });
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
