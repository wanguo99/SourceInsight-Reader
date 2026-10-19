'use strict';
const vscode = require('vscode');
const { enclosingFunction, locationKey } = require('../core');
const { sameUri } = require('../resources');
function connectEvents(app) {
    app.disposables.push(
      app.localIndex.onDidChange(() => {
        app.relationEngine.invalidate();
        app.relations.invalidate();
        clearTimeout(app.relationTimer);
        app.relationTimer = setTimeout(() => app.run(async () => {
          const source = app.relations.source;
          if (source) await app.relations.setRoot(source, { manual: true });
        }), 150);
      }),

      vscode.window.onDidChangeActiveTextEditor(editor => app.run(() => app.follow.acceptEditor(editor))),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor !== app.session.editor) return;
        const position = app.navigation.readingPosition();
        if (event.kind === vscode.TextEditorSelectionChangeKind.Command && !app.session.navigationDepth) {
          if (app.session.position) app.session.history.push(app.session.position);
          if (position) app.session.history.push(position);
        }
        app.session.position = position;
        // Invalidate immediately; the old query must not win during the debounce interval.
        app.preview.invalidateAuto(); app.session.previewKey = undefined;
        if (!app.relations.locked) {
          const fn = sameUri(app.symbols.uri, event.textEditor.document.uri)
            ? enclosingFunction(app.symbols.nodes, event.textEditor.selection.active) : undefined;
          const next = app.follow.relationSource(fn, app.navigation.source());
          if (next && locationKey(next) !== app.session.relationKey) app.relations.invalidate();
        }
        app.follow.schedule();
      }),
      app.catalog.onDidChange(event => {
        if (event.kind !== 'edit') return;
        app.relationEngine.invalidate();
        app.references.markStale(); app.relations.invalidate(); app.session.relationKey = undefined;
        app.session.previewKey = undefined;
        app.preview.invalidateAuto();
        if (sameUri(app.preview.current?.uri, event.document.uri)) {
          app.preview.current.stale = true;
          clearTimeout(app.previewTimer);
          app.previewTimer = setTimeout(() => app.run(() => app.preview.refresh()), 200);
        }
        if (sameUri(event.document.uri, app.session.editor?.document.uri)) {
          app.symbols.invalidate(); clearTimeout(app.symbolTimer);
          app.symbolTimer = setTimeout(() => app.run(() => app.follow.reloadSymbols()), app.config('debounceMs', 250));
        }
      }),
      app.catalog.onDidChange(change => {
        if (change.kind !== 'config') return;
        const event = change.configuration;
        if (event.affectsConfiguration('sourceInsightReader.explorerSide')) app.run(() => app.layout.applySidebar());
        if (event.affectsConfiguration('workbench.colorTheme') || event.affectsConfiguration('sourceInsightReader.symbolHighlightUseF2')) app.preview.publish();
        if (event.affectsConfiguration('sourceInsightReader.relationView')) { app.run(() => app.relationView.publish()); return; }
        if (!event.affectsConfiguration('sourceInsightReader') && !event.affectsConfiguration('files.exclude')) return;
        app.symbols.sort = app.config('symbolSort', 'position');
        app.symbols.allSymbols = app.config('symbolKinds', 'all') === 'all'; app.symbols.refresh(); app.follow.syncSymbolDescription();
        if (event.affectsConfiguration('sourceInsightReader.relationBackend')) { app.relationEngine.invalidate(true); app.relations.invalidate(); }
        app.session.relationKey = undefined; app.session.previewKey = undefined; app.follow.schedule();
      }),
      app.symbolView.onDidChangeVisibility(event => { if (event.visible && app.session.editor) app.run(() => app.follow.reloadSymbols()); }),
      app.relationView.onDidChangeSelection(event => app.run(() => app.navigation.selectTarget(event.selection[0]))),
      app.symbolView.onDidChangeSelection(event => {
        if (!app.session.revealingSymbols) app.run(() => app.navigation.selectTarget(event.selection[0]));
      })
    );
    app.disposables.push(app.catalog.onDidChange(event => {
      if (event.kind === 'folders') { app.relationEngine.invalidate(); app.relations.invalidate(); return; }
      if (!['create', 'delete', 'change'].includes(event.kind)) return;
      const uri = event.uri;
      if (/(?:^|\/)(?:\.git|\.cache|node_modules|build|dist|out|research)(?:\/|$)/.test(uri.path)) return;
      app.references.markStale();
      if (!/\.(?:c|h|cc|cpp|cxx|hpp|hxx|clangd)$/.test(uri.path) && !/compile_commands\.json$/.test(uri.path)) return;
      app.relationEngine.invalidate(); app.relations.invalidate();
    }));
  }
module.exports = { connectEvents };
