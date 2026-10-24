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
    assert(!vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd'), 'Offline host has no clangd extension');
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'SourceInsight-Reader Source Insight', vscode.ConfigurationTarget.Workspace);
    const config = vscode.workspace.getConfiguration('sourceInsightReader');
    await config.update('autoPreview', false, vscode.ConfigurationTarget.Workspace);
    await config.update('autoRelation', false, vscode.ConfigurationTarget.Workspace);
    await config.update('indexEnabled', false, vscode.ConfigurationTarget.Workspace);
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'offline-colors.c');
    fs.writeFileSync(uri.fsPath, '#include "unavailable-build-header.h"\nstruct R { int field; };\n' +
      'static int count;\nint leaf(int value) { return value; }\nint run(struct R *r) { int local = leaf(r->field); return local + count; }\n');
    const document = await vscode.workspace.openTextDocument(uri), editor = await vscode.window.showTextDocument(document);
    const spans = async () => { await controller.editorCColors.update(); return controller.editorCColors.applied.get(editor)?.spans; };
    await check('offline: native C variables, fields, parameters and calls are colored without clangd or project index', async () => {
      const applied = await waitFor(spans, 'native fallback');
      const word = span => document.lineAt(span.line).text.slice(span.start, span.end);
      assert(applied.some(span => word(span) === 'local' && !span.modifiers.length && span.style.foreground === '#006b6b'));
      assert(applied.some(span => word(span) === 'count' && span.modifiers.includes('static') && span.style.foreground === '#800080'));
      assert(applied.some(span => word(span) === 'field' && !span.modifiers.length && span.style.foreground === '#008000'));
      assert(applied.some(span => word(span) === 'leaf' && !span.modifiers.length && span.style.bold));
      assert.equal(controller.localIndex.worker, undefined);
      assert.deepEqual(await controller.language.semanticTokens(uri, document.languageId), []);
    });
    await check('offline: Context shares syntax colors and updates resource scoped user overrides', async () => {
      await controller.preview.show({ uri, range: new vscode.Range(4, 0, 4, 0) });
      await waitFor(() => controller.preview.state.lines.find(line => line.number === 5)?.tokens.some(token => token.text === 'local' && token.foreground === '#006b6b'), 'Context variable');
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
      await controller.editorCColors.update(); assert.equal(controller.editorCColors.applied.get(editor), undefined);
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
    completed = true;
  } finally {
    fs.writeFileSync(process.env.SOURCEINSIGHT_READER_REPORT, JSON.stringify({ vscode: vscode.version, platform: process.platform,
      installation: process.env.SOURCEINSIGHT_READER_INSTALLATION, completed, results, passed: results.filter(result => result.passed).length, skipped: 0 }, null, 2));
  }
}
module.exports = { run };
