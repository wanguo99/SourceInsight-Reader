'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');
const { captureUi } = require('./capture');
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function waitFor(action, description) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const value = await action(); if (value) return value; await pause(); }
  throw new Error(`Timed out: ${description}`);
}
async function run() {
  const extension = vscode.extensions.getExtension('wanguo.wanguo-sourceinsight-reader');
  const controller = await extension.activate(), results = [];
  let completed = false;
  async function check(name, action) {
    const start = Date.now();
    try { await action(); results.push({ name, passed: true, durationMs: Date.now() - start }); console.log('PASS ' + name); }
    catch (error) { results.push({ name, passed: false, error: String(error) }); throw error; }
  }
  try {
    await check('startup: default layout resolves Context without an explicit open command', async () => {
      assert.equal(vscode.workspace.getConfiguration('sourceInsightReader').get('layout'), 'preserve');
      await waitFor(() => controller.readingPanel.port, 'automatic Context startup');
    });
    assert(!vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd'), 'Offline host has no clangd extension');
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'SourceInsight-Reader Source Insight', vscode.ConfigurationTarget.Workspace);
    const config = vscode.workspace.getConfiguration('sourceInsightReader');
    await config.update('autoPreview', false, vscode.ConfigurationTarget.Workspace);
    await config.update('autoRelation', false, vscode.ConfigurationTarget.Workspace);
    await config.update('indexEnabled', false, vscode.ConfigurationTarget.Workspace);
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'offline-colors.c');
    fs.writeFileSync(uri.fsPath, '#include "unavailable-build-header.h"\nstruct R { int field; };\n' +
      'static int count;\nint leaf(int value) { return value; }\nint run(struct R *r) { int local = leaf(r->field); return local + count + MISSING + absent(); }\n');
    const document = await vscode.workspace.openTextDocument(uri), editor = await vscode.window.showTextDocument(document);
    const spans = async () => { await controller.editorCColors.update(); return controller.editorCColors.applied.get(editor)?.spans; };
    await check('offline: known bindings are colored and unresolved identifiers use the editor foreground', async () => {
      const applied = await waitFor(spans, 'native fallback');
      const word = span => document.lineAt(span.line).text.slice(span.start, span.end);
      assert(applied.some(span => word(span) === 'local' && !span.modifiers.length && span.style.foreground === '#006b6b'));
      assert(applied.some(span => word(span) === 'count' && span.modifiers.includes('static') && span.style.foreground === '#800080'));
      for (const name of ['field', 'MISSING', 'absent']) assert(applied.some(span => word(span) === name && span.unresolved && span.style.foreground.id === 'editor.foreground'));
      assert(applied.some(span => word(span) === 'leaf' && !span.modifiers.length && span.style.bold));
      assert.equal(controller.localIndex.worker, undefined);
      assert.deepEqual(await controller.language.semanticTokens(uri, document.languageId), []);
    });
    await check('offline: Context shares syntax colors and updates resource scoped user overrides', async () => {
      await controller.preview.show({ uri, range: new vscode.Range(4, 0, 4, 0) });
      await waitFor(() => controller.preview.state.lines.find(line => line.number === 5)?.tokens.some(token => token.text === 'local' && token.foreground === '#006b6b'), 'Context variable');
      for (const name of ['MISSING', 'absent']) {
        const token = controller.preview.state.lines.find(line => line.number === 5).tokens.find(token => token.text === name);
        assert(token.defaultText); assert.equal(token.foreground, '#000000'); assert.equal(token.bold, false);
      }
      await vscode.workspace.getConfiguration('editor', uri).update('semanticTokenColorCustomizations', {
        '[SourceInsight-Reader Source Insight]': { rules: { 'variable:c': '#123456' } }
      }, vscode.ConfigurationTarget.Workspace);
      await waitFor(async () => (await spans())?.some(span => span.line === 4 && span.type === 'variable' && !span.modifiers.length && span.style.foreground === '#123456'), 'native custom variable');
      await controller.preview.refresh();
      await waitFor(() => controller.preview.state.lines.find(line => line.number === 5)?.tokens.some(token => token.text === 'local' && token.foreground === '#123456'), 'Context custom variable');
      await vscode.commands.executeCommand('sourceInsightReader.open');
      await captureUi('offline-c-colors');
    });
    await check('offline: unsaved edits invalidate native spans; semantic opt-out and other themes clear fallback', async () => {
      const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(0, 0), '// shifted\n'); await vscode.workspace.applyEdit(edit);
      await waitFor(async () => { await spans(); return controller.editorCColors.applied.get(editor)?.version === document.version; }, 'edited version');
      const applied = controller.editorCColors.applied.get(editor).spans;
      assert(applied.every(span => span.line > 1));
      await vscode.workspace.getConfiguration('editor', uri).update('semanticHighlighting.enabled', false, vscode.ConfigurationTarget.Workspace);
      await controller.editorCColors.update(); assert.equal(controller.editorCColors.applied.get(editor), undefined);
      await vscode.workspace.getConfiguration('editor', uri).update('semanticHighlighting.enabled', true, vscode.ConfigurationTarget.Workspace);
      await waitFor(spans, 're-enabled fallback');
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Workspace);
      await waitFor(() => !controller.editorCColors.enabled(document), 'rendered theme change');
      await controller.editorCColors.update(); assert.equal(controller.editorCColors.applied.get(editor), undefined);
    });
    await check('macro: provider-confirmed references and definitions stay red in the main editor', async () => {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'SourceInsight-Reader Source Insight', vscode.ConfigurationTarget.Workspace);
      const macroUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'macro-colors.c');
      fs.writeFileSync(macroUri.fsPath, '#define ESP_OK 0\nint run(void) { return ESP_OK + MISSING; }\n');
      const doc = await vscode.workspace.openTextDocument(macroUri), view = await vscode.window.showTextDocument(doc);
      const legend = new vscode.SemanticTokensLegend(['macro'], ['declaration']);
      const provider = vscode.languages.registerDocumentSemanticTokensProvider({ language: 'c', pattern: '**/macro-colors.c' }, {
        provideDocumentSemanticTokens() {
          const builder = new vscode.SemanticTokensBuilder(legend);
          builder.push(new vscode.Range(0, 8, 0, 14), 'macro', ['declaration']);
          builder.push(new vscode.Range(1, 23, 1, 29), 'macro', []); return builder.build();
        }
      }, legend);
      try {
        await waitFor(async () => (await controller.language.semanticTokens(macroUri, 'c')).length === 2, 'macro semantic provider');
        await controller.editorCColors.update();
        const applied = controller.editorCColors.applied.get(view).spans;
        assert.equal(applied.find(span => span.line === 1 && span.start === 23)?.style.foreground, '#c00000');
        assert.equal(applied.find(span => span.line === 0 && span.start === 8)?.style.foreground, '#c00000');
        const missing = applied.find(span => doc.lineAt(span.line).text.slice(span.start, span.end) === 'MISSING');
        assert.equal(missing.style.foreground.id, 'editor.foreground');
        await controller.preview.show({ uri: macroUri, range: new vscode.Range(0, 8, 0, 14) });
        await waitFor(() => controller.preview.state.lines[0]?.tokens.some(token => token.text === 'ESP_OK' && token.foreground === '#c00000'), 'Context macro definition red');
        assert.equal(controller.preview.highlightSymbol || '', '', 'No F8 highlighting involved');
        await vscode.commands.executeCommand('sourceInsightReader.open');
        await new Promise(resolve => setTimeout(resolve, 500));
        await captureUi('macro-definition-colors');
      } finally { provider.dispose(); }
    });
    await check('renderer theme id takes precedence over stale remote configuration', async () => {
      const theme = require(require('node:path').join(extension.extensionPath, 'src/theme'));
      await waitFor(() => theme.effectiveTheme('Dark 2026') === 'SourceInsight-Reader Source Insight', 'theme reported by visible webview');
    });
    const fixture = process.env.SOURCEINSIGHT_READER_COLOR_FIXTURE;
    if (fixture) await check('offline: actual screenshot OAI source has local variables, static references, fields and calls', async () => {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'SourceInsight-Reader Source Insight', vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('editor', uri).update('semanticTokenColorCustomizations', undefined, vscode.ConfigurationTarget.Workspace);
      const target = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'oaioran.c');
      fs.copyFileSync(fixture, target.fsPath);
      const doc = await vscode.workspace.openTextDocument(target), view = await vscode.window.showTextDocument(doc);
      view.revealRange(new vscode.Range(285, 0, 335, 0), vscode.TextEditorRevealType.InCenter);
      await waitFor(async () => { await controller.editorCColors.update(); return controller.editorCColors.applied.get(view); }, 'OAI native coloring');
      const local = await controller.language.localColorTokens(doc), text = doc.getText().split('\n');
      for (const name of ['ptr', 'pos', 'last_slot', 'oran_sync_info']) assert(local.some(span => text[span.line].slice(span.start, span.end) === name), name);
      assert(local.some(span => span.line === 327 && span.type === 'variable' && span.modifiers.includes('static')));
      assert(local.some(span => span.line === 314 && span.type === 'property'));
      await controller.preview.show({ uri: target, range: new vscode.Range(287, 8, 287, 11) });
      await waitFor(() => controller.preview.state.lines.find(line => line.number === 288)?.tokens.some(token => token.text === 'ptr' && token.foreground === '#000080'), 'OAI Context declaration');
      view.revealRange(new vscode.Range(312, 0, 330, 0), vscode.TextEditorRevealType.InCenter);
      await new Promise(resolve => setTimeout(resolve, 500));
      await captureUi('offline-oai-colors');
    });
    const projectFixture = process.env.SOURCEINSIGHT_READER_COLOR_PROJECT;
    if (projectFixture) await check('real project: runtime_start macro stays red when semantic provider fails', async () => {
      const path = require('node:path');
      const targetRoot = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'macro-project');
      fs.cpSync(projectFixture, targetRoot, { recursive: true, filter: source => !['.git', '.vscode', '.cache', 'build', 'node_modules'].includes(path.basename(source)) });
      await config.update('indexEnabled', true, vscode.ConfigurationTarget.Workspace);
      const target = vscode.Uri.file(path.join(targetRoot, 'components/runtime/runtime.c'));
      const doc = await vscode.workspace.openTextDocument(target), view = await vscode.window.showTextDocument(doc);
      const position = new vscode.Position(77, 18);
      view.selection = new vscode.Selection(position, position);
      view.revealRange(new vscode.Range(73, 0, 87, 0), vscode.TextEditorRevealType.InCenter);
      const provider = vscode.languages.registerDocumentSemanticTokensProvider({ language: 'c', pattern: '**/runtime.c' }, {
        provideDocumentSemanticTokens() { throw new Error('invalid AST'); }
      }, new vscode.SemanticTokensLegend(['macro'], []));
      try {
        await controller.localIndex.refresh();
        await waitFor(() => controller.editorCColors.applied.get(view)?.spans.some(span => span.line === 77 && span.start === 18 && span.style.foreground === '#c00000'), 'automatic runtime_start macro coloring');
        const definitions = await controller.language.definitions(target, position);
        assert(definitions.length, 'same-project ESP_OK definition');
        const local = await controller.language.localColorTokens(doc, view.visibleRanges);
        console.log('MACRO DEBUG ' + JSON.stringify({ language: doc.languageId, enabled: controller.editorCColors.enabled(doc),
          ranges: view.visibleRanges, tokens: local.filter(span => span.line === 77),
          failures: controller.language.localCColors.failed.get(doc), firstSnapshot: controller.localIndex.firstSnapshotPending }));
        await controller.preview.definition({ uri: target, range: new vscode.Range(position, position) });
        await controller.editorCColors.update();
        const applied = controller.editorCColors.applied.get(view)?.spans || [];
        console.log('MACRO APPLIED ' + JSON.stringify(applied.filter(span => span.line === 77)));
        await captureUi('runtime-start-macro');
        assert.equal(applied.find(span => span.line === 77 && span.start === 18)?.style.foreground, '#c00000');
      } finally { provider.dispose(); }
    });
    const nfapiRoot = process.env.SOURCEINSIGHT_READER_NFAPI_ROOT;
    if (nfapiRoot) await check('OAI: actual GERAN source colors local bindings, indexed macros and nested fields', async () => {
      const path = require('node:path');
      const root = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'nfapi');
      fs.cpSync(nfapiRoot, root, { recursive: true });
      await config.update('indexEnabled', true, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('editor').update('semanticTokenColorCustomizations', undefined, vscode.ConfigurationTarget.Workspace);
      const target = vscode.Uri.file(path.join(root, 'tests/nfapi_cunit_main.c'));
      const doc = await vscode.workspace.openTextDocument(target), view = await vscode.window.showTextDocument(doc);
      view.revealRange(new vscode.Range(399, 0, 428, 0), vscode.TextEditorRevealType.AtTop);
      await controller.localIndex.refresh();
      const colors = controller.language.localCColors;
      colors.cache.delete(doc);
      const interrupted = colors.colorize(doc);
      colors.worker.emit('error', new Error('simulated transient failure'));
      assert.deepEqual(await interrupted, []);
      const version = doc.version;
      await waitFor(async () => {
        await controller.editorCColors.update();
        return controller.editorCColors.applied.get(view)?.spans.some(span => span.line === 405 && span.start === 1 && !span.unresolved);
      }, 'unchanged OAI document recovers after coloring failure');
      assert.equal(doc.version, version);
      const applied = controller.editorCColors.applied.get(view)?.spans || [];
      assert.equal(applied.find(span => span.line === 410 && span.start === 15)?.style.foreground, '#c00000');
      for (const name of ['in', 'header', 'phy_id', 'NFAPI_PHY_ID_NA']) {
        const span = applied.find(span => span.line === 405 && doc.lineAt(span.line).text.slice(span.start, span.end) === name);
        assert(span && !span.unresolved, 'GERAN resolved color: ' + name);
      }
      await controller.preview.show({ uri: target, range: new vscode.Range(405, 20, 405, 35) });
      await captureUi('oai-geran-colors');
    });
    completed = true;
  } finally {
    fs.writeFileSync(process.env.SOURCEINSIGHT_READER_REPORT, JSON.stringify({ vscode: vscode.version, platform: process.platform,
      installation: process.env.SOURCEINSIGHT_READER_INSTALLATION, completed, results, passed: results.filter(result => result.passed).length, skipped: 0 }, null, 2));
  }
}
module.exports = { run };
