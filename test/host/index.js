'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ContextView } = require('../../src/context');
const { SymbolTree, ReferencesTree } = require('../../src/trees');
const { locationKey } = require('../../src/core');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(action, predicate, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let result;
  while (Date.now() < deadline) {
    result = await action();
    if (predicate(result)) return result;
    await sleep(250);
  }
  throw new Error(`Timed out: ${description}; last result: ${JSON.stringify(result)}`);
}
function at(document, text, offset = 0) {
  const index = document.getText().indexOf(text);
  assert.notEqual(index, -1, `Missing fixture text: ${text}`);
  const position = document.positionAt(index + offset);
  return { uri: document.uri, range: new vscode.Range(position, position), name: text };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function run() {
  const results = [];
  let completed = false;
  async function check(name, action, skip) {
    if (skip) { results.push({ name, skipped: skip }); console.log(`SKIP ${name}: ${skip}`); return; }
    const start = Date.now();
    try { await action(); }
    catch (error) { results.push({ name, passed: false, error: String(error) }); throw error; }
    results.push({ name, passed: true, durationMs: Date.now() - start });
    console.log(`PASS ${name}`);
  }
  const extension = vscode.extensions.getExtension('wanguo.wanguo-sourceinsight-reader');
  assert.ok(extension, 'Extension was discovered');
  const controller = await extension.activate();
  const config = vscode.workspace.getConfiguration('sourceInsightReader');
  const oldAutoPreview = config.inspect('autoPreview')?.workspaceValue;
  const oldAutoRelation = config.inspect('autoRelation')?.workspaceValue;
  await config.update('autoPreview', false, vscode.ConfigurationTarget.Workspace);
  await config.update('autoRelation', false, vscode.ConfigurationTarget.Workspace);
  try {
    await check('local Context resolves enums with real VS Code positions across the Worker boundary', async () => {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'local-index.c');
      fs.writeFileSync(uri.fsPath, 'enum Backoff { BMC_BACKOFF_UNSUPPORTED = 4 };\n' +
        'int leaf(void) { return 0; }\nint caller(void) { return BMC_BACKOFF_UNSUPPORTED + leaf(); }\n' +
        'struct Sensor { int value; };\nstruct Sensor *read_sensor(struct Sensor *sensor) { return sensor; }\n' +
        'struct Result { struct Sensor *samples; };\nvoid consume(struct Result *result) { result->samples; }\n');
      const document = await vscode.workspace.openTextDocument(uri);
      await controller.localIndex.refresh(true);
      const position = new vscode.Position(2, document.lineAt(2).text.indexOf('BMC_BACKOFF_UNSUPPORTED'));
      const definitions = await controller.localIndex.definitions(uri, position);
      assert.equal(definitions.length, 1);
      assert.equal(definitions[0].range.start.line, 0);
      await controller.preview.definition({ uri, range: new vscode.Range(position, position) });
      assert.equal(controller.preview.current.uri.toString(), uri.toString());
      assert.equal(controller.preview.current.range.start.line, 0);
      const call = new vscode.Position(2, document.lineAt(2).text.indexOf('leaf'));
      assert.equal((await controller.localIndex.prepare(uri, call))[0].name, 'leaf');
      for (const character of [document.lineAt(4).text.indexOf('Sensor'), document.lineAt(4).text.lastIndexOf('Sensor')]) {
        await controller.preview.show({ uri, range: new vscode.Range(4, 0, 4, 0) });
        await controller.preview.handleMessage({ action: 'navigate', snapshot: controller.preview.snapshot, line: 4, character });
        assert.equal(controller.preview.current.range.start.line, 3);
        assert.equal(controller.preview.current.range.start.character, 7);
      }
      await controller.preview.show({ uri, range: new vscode.Range(6, 0, 6, 0) });
      await controller.preview.handleMessage({ action: 'navigate', snapshot: controller.preview.snapshot, line: 6,
        character: document.lineAt(6).text.indexOf('samples') });
      assert.equal(controller.preview.current.range.start.line, 5, 'field click stays on its declaration');
      await controller.preview.handleMessage({ action: 'navigate', snapshot: controller.preview.snapshot, line: 5,
        character: document.lineAt(5).text.indexOf('Sensor') });
      assert.equal(controller.preview.current.range.start.line, 3, 'type name click enters the field type');
      await controller.preview.show({ uri, range: new vscode.Range(6, 0, 6, 0) });
      await controller.preview.handleMessage({ action: 'navigate', snapshot: controller.preview.snapshot, line: 6,
        character: document.lineAt(6).text.lastIndexOf('result') });
      assert.equal(controller.preview.current.range.start.line, 6, 'variable click stays on its declaration');
      assert.equal(controller.preview.current.range.start.character, document.lineAt(6).text.indexOf('result'));
    });
    const clangd = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
    assert.ok(clangd, 'clangd extension must be installed');
    await clangd.activate();
    const clangdPath = vscode.workspace.getConfiguration('clangd').get('path', 'clangd');
    const version = await promisify(execFile)(clangdPath, ['--version'], { encoding: 'utf8' });
    const major = Number(/version\s+(\d+)/.exec(version.stdout)?.[1] || 0);
    const folder = vscode.workspace.workspaceFolders[0].uri;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'reader.cpp'));
    const main = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'main.cpp'));
    const header = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'reader.h'));
    await vscode.window.showTextDocument(main);
    await vscode.window.showTextDocument(header);
    const editor = await vscode.window.showTextDocument(document);
    await controller.follow.acceptEditor(editor);
    const leaf = at(document, 'leaf(int', 1);
    const process = at(document, 'process_request(const', 1);
    const call = at(document, 'leaf(request.value)', 1);
    const recurse = at(document, 'recurse(int', 1);

    await check('clangd: current-file symbols and function list', async () => {
      await waitFor(() => controller.language.symbols(document.uri), nodes => nodes.some(node => node.name === 'leaf'), 'clangd symbols');
      await controller.symbols.load(document.uri);
      assert.ok(controller.symbols.nodes.some(node => node.name === 'process_request'));
      const tree = controller.symbols.getChildren();
      assert.ok(tree.some(node => node.name === 'leaf'));
    });

    await check('file catalog: source files discoverable and exact folder identity retained', async () => {
      const uris = await controller.catalog.list();
      assert.ok(uris.some(uri => uri.toString() === document.uri.toString()));
      assert.equal(controller.catalog.folder(document.uri).uri.toString(), folder.toString());
    });

    await check('theme: function return type and name are emphasized without formatting the body', async () => {
      const workbench = vscode.workspace.getConfiguration('workbench');
      const oldTheme = workbench.inspect('colorTheme')?.workspaceValue;
      try {
        await workbench.update('colorTheme', 'SourceInsight-Reader Source Insight', vscode.ConfigurationTarget.Workspace);
        await controller.symbols.load(document.uri);
        const head = controller.functionHeadStyle.cache.get(document).ranges.find(range =>
          range.end.line === leaf.range.start.line && range.end.character > leaf.range.start.character);
        assert.ok(head, 'Native editor has a function-head decoration range');
        const text = document.getText(new vscode.Range(head.start, head.end));
        assert.match(text, /int\s+leaf$/);
        assert(!text.includes('{'));
        await controller.preview.show({ uri: document.uri, range: leaf.range });
        const state = await waitFor(async () => controller.preview.state, state =>
          state.lines.some(line => line.tokens.some(token => token.strong && token.text === 'leaf')), 'Context function emphasis');
        const line = state.lines.find(line => line.number === leaf.range.start.line + 1);
        assert.equal(line.tokens.filter(token => token.strong).map(token => token.text).join('').trim(), 'int leaf');
      } finally { await workbench.update('colorTheme', oldTheme, vscode.ConfigurationTarget.Workspace); }
    });

    await check('clangd: definition and Context preserve main reading position', async () => {
      const definitions = await controller.language.definitions(call.uri, call.range.start);
      assert.ok(definitions.length);
      assert.equal(path.basename(definitions[0].uri.fsPath), 'reader.cpp');
      const before = editor.selection;
      await controller.preview.definition(call);
      assert.ok(controller.preview.current);
      assert.equal(controller.preview.current.uri.toString(), definitions[0].uri.toString());
      assert.equal(vscode.window.activeTextEditor, editor);
      assert.equal(editor.selection, before);
      assert.ok(controller.preview.state.lines.some(line => line.text.includes('int leaf(int value)')));
    });

    await check('Context: lock blocks selection and refresh keeps pinned target', async () => {
      const original = locationKey(controller.preview.current);
      controller.preview.toggleLock();
      await controller.preview.show({ ...process, mode: '定义' });
      assert.equal(locationKey(controller.preview.current), original);
      await controller.preview.refresh();
      assert.equal(locationKey(controller.preview.current), original);
      controller.preview.toggleLock();
    });

    await check('clangd: incoming calls retain both process_request call sites', async () => {
      controller.relations.direction = 'incoming';
      await controller.relations.setRoot(leaf, { manual: true });
      assert.ok(controller.relations.root);
      const children = await waitFor(async () => (await controller.relations.load(controller.relations.root, 'incoming')).data,
        nodes => nodes.some(node => node.symbol.name.includes('process_request')), 'incoming process_request');
      const caller = children.find(node => node.symbol.name.includes('process_request'));
      assert.equal(caller.sites.length, 2);
      assert.ok(caller.sites.every(site => site.uri.toString() === document.uri.toString()));
      await controller.navigation.selectTarget({ type: 'callsite', uri: vscode.Uri.parse(caller.sites[0].uri), range: new vscode.Range(caller.sites[0].range.start.line, caller.sites[0].range.start.character, caller.sites[0].range.end.line, caller.sites[0].range.end.character) });
      assert.equal(controller.preview.current.mode, '调用现场');
      assert.equal(controller.preview.current.range.start.line, call.range.start.line);
    });

    await check('clangd: outgoing calls use caller URI, direction switch keeps root', async () => {
      await controller.relations.setRoot(process, { manual: true });
      const rootName = controller.relations.root.name;
      await controller.navigation.setDirection('outgoing');
      assert.equal(controller.relations.root.name, rootName);
      const children = (await controller.relations.load(controller.relations.root, 'outgoing')).data;
      const callee = children.find(node => node.symbol.name.includes('leaf'));
      assert.ok(callee, 'clangd provides outgoing calls');
      assert.equal(callee.sites.length, 2);
      assert.ok(callee.sites.every(site => site.uri.toString() === document.uri.toString()));
    }, major > 0 && major < 20 ? 'clangd 20+ required for outgoing calls' : undefined);

    await check('clangd: recursive relation terminates at cycle', async () => {
      controller.relations.direction = 'incoming';
      await controller.relations.setRoot(recurse, { manual: true });
      const children = (await controller.relations.load(controller.relations.root, 'incoming')).data;
      const cycle = children.find(node => node.symbol.id === controller.relations.root.id);
      assert.ok(cycle);
      const node = controller.relationView.node(cycle.symbol, cycle.sites, [controller.relations.root.id]);
      assert.match(controller.relationView.children(node, 'incoming')[0].label, /递归/);
    });

    await check('clangd: references grouped with snippets and call-site preview', async () => {
      await controller.references.lookup(leaf);
      const group = controller.references.groups.find(node => node.uri.toString() === document.uri.toString());
      assert.ok(group);
      const children = await controller.references.getChildren(group);
      const reference = children.find(node => node.range.start.line === call.range.start.line);
      assert.ok(reference.snippet.includes('leaf(request.value)'));
      await controller.navigation.selectTarget(reference);
      assert.equal(controller.preview.current.mode, '引用现场');
      assert.equal(controller.preview.current.range.start.line, call.range.start.line);
      const count = controller.references.groups.length;
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await controller.follow.follow();
      assert.equal(controller.references.groups.length, count);
    });

    await check('reference filter/history and global-symbol search use the real language service', async () => {
      await controller.references.filter('reader.cpp');
      assert.ok(controller.references.allVisibleReferences().length);
      assert.ok(controller.references.allVisibleReferences().every(reference => path.basename(reference.uri.fsPath) === 'reader.cpp'));
      await controller.references.filter('');
      assert.ok(controller.references.recentSources.length);
      controller.pickers.symbols('leaf');
      await waitFor(async () => controller.pickers.active?.picker.items || [],
        items => items.some(item => item.label.includes('leaf')), 'workspace symbol picker');
      controller.pickers.close();
    });

    await check('Context: late definition response cannot replace newer selection', async () => {
      const delayed = deferred();
      const preview = new ContextView({
        definitions: sourceUri => sourceUri.toString() === main.uri.toString() ? delayed.promise : Promise.resolve([process])
      }, () => {});
      const old = preview.definition({ ...leaf, uri: main.uri });
      await preview.definition(process);
      delayed.resolve([leaf]); await old;
      assert.equal(preview.current.range.start.line, process.range.start.line);
      preview.dispose();
    });

    await check('Context: multiple definitions require an explicit candidate', async () => {
      const preview = new ContextView({ definitions: async () => [leaf, process] }, () => {});
      await preview.definition(leaf);
      assert.equal(preview.current, undefined);
      assert.equal(preview.state.candidates.length, 2);
      await preview.handleMessage({ action: 'candidate', index: 1 });
      assert.equal(preview.current.range.start.line, process.range.start.line);
      preview.dispose();
    });

    await check('symbols and references reject late sessions and retain full ranges', async () => {
      const delayed = deferred();
      const symbols = new SymbolTree({ symbols: sourceUri => sourceUri.toString() === main.uri.toString()
        ? delayed.promise : Promise.resolve(controller.symbols.nodes) });
      const old = symbols.load(main.uri);
      await symbols.load(document.uri); delayed.resolve([]); await old;
      assert.equal(symbols.uri.toString(), document.uri.toString());
      assert.ok(symbols.nodes.length); symbols.dispose();
      const references = new ReferencesTree({ references: async () => [leaf, leaf, process] });
      await references.lookup(leaf);
      // Production LanguageAdapter deduplicates provider results; this fake exercises tree grouping only.
      assert.equal(references.groups.length, 1);
      references.clear(); assert.equal(references.groups.length, 0); references.dispose();
    });

    await check('unsaved buffer updates preview and marks semantic results stale', async () => {
      await controller.preview.show({ ...leaf, mode: '定义' });
      controller.preview.toggleLock();
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(0, 0), '// unsaved preview test\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(300);
      assert.equal(controller.references.stale, true);
      assert.equal(controller.relations.rootState.status, 'stale');
      assert.ok(controller.preview.state.status.includes('未保存'));
      const undo = new vscode.WorkspaceEdit();
      undo.delete(document.uri, new vscode.Range(0, 0, 1, 0));
      await vscode.workspace.applyEdit(undo);
      await document.save();
      controller.preview.toggleLock();
    });

    await check('all declared commands registered and workbench views can open', async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const command of extension.packageJSON.contributes.commands) assert.ok(commands.includes(command.command), command.command);
      await vscode.commands.executeCommand('sourceInsightReader.open');
      await sleep(800);
      assert.ok(controller.readingPanel.port, 'Combined reading webview resolved');
    });
    completed = true;
  } finally {
    await config.update('autoPreview', oldAutoPreview, vscode.ConfigurationTarget.Workspace);
    await config.update('autoRelation', oldAutoRelation, vscode.ConfigurationTarget.Workspace);
    if (process.env.SOURCEINSIGHT_READER_REPORT) {
      fs.mkdirSync(path.dirname(process.env.SOURCEINSIGHT_READER_REPORT), { recursive: true });
      fs.writeFileSync(process.env.SOURCEINSIGHT_READER_REPORT, JSON.stringify({
        vscode: vscode.version, platform: process.platform, completed, results, passed: results.filter(result => result.passed).length,
        skipped: results.filter(result => result.skipped).length
      }, null, 2));
    }
  }
  console.log(`${results.filter(result => result.passed).length} extension-host checks passed; ${results.filter(result => result.skipped).length} skipped.`);
}

module.exports = { run };
