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
  const extension = vscode.extensions.getExtension('local-dev.source-reader');
  assert.ok(extension, 'Extension was discovered');
  const controller = await extension.activate();
  const config = vscode.workspace.getConfiguration('sourceReader');
  const oldAutoPreview = config.inspect('autoPreview')?.workspaceValue;
  const oldAutoRelation = config.inspect('autoRelation')?.workspaceValue;
  await config.update('autoPreview', false, vscode.ConfigurationTarget.Workspace);
  await config.update('autoRelation', false, vscode.ConfigurationTarget.Workspace);
  try {
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
    await controller.acceptEditor(editor);
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

    await check('file tree: source files visible and .git/node_modules excluded', async () => {
      const roots = await controller.files.getChildren();
      const children = await controller.files.getChildren(roots[0]);
      assert.ok(children.some(node => node.name === 'reader.cpp'));
      assert.ok(!children.some(node => ['.git', 'node_modules'].includes(node.name)));
      assert.equal((await controller.files.find(document.uri)).name, 'reader.cpp');
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
      await controller.relations.setRoot(leaf, true);
      assert.ok(controller.relations.root);
      const children = await waitFor(() => controller.relations.getChildren(controller.relations.root),
        nodes => nodes.some(node => node.name?.includes('process_request')), 'incoming process_request');
      const caller = children.find(node => node.name?.includes('process_request'));
      assert.equal(caller.sites.length, 2);
      assert.ok(caller.sites.every(site => site.uri.toString() === document.uri.toString()));
      const sites = await controller.relations.getChildren({ type: 'sites', sites: caller.sites });
      await controller.selectTarget(sites[0]);
      assert.equal(controller.preview.current.mode, '调用现场');
      assert.equal(controller.preview.current.range.start.line, call.range.start.line);
    });

    await check('clangd: outgoing calls use caller URI, direction switch keeps root', async () => {
      await controller.relations.setRoot(process, true);
      const rootName = controller.relations.root.name;
      await controller.setDirection('outgoing');
      assert.equal(controller.relations.root.name, rootName);
      const children = await controller.relations.getChildren(controller.relations.root);
      const callee = children.find(node => node.name?.includes('leaf'));
      assert.ok(callee, 'clangd provides outgoing calls');
      assert.equal(callee.sites.length, 2);
      assert.ok(callee.sites.every(site => site.uri.toString() === document.uri.toString()));
    }, major > 0 && major < 20 ? 'clangd 20+ required for outgoing calls' : undefined);

    await check('clangd: recursive relation terminates at cycle', async () => {
      controller.relations.direction = 'incoming';
      await controller.relations.setRoot(recurse, true);
      const children = await controller.relations.getChildren(controller.relations.root);
      const cycle = children.find(node => node.cycle);
      assert.ok(cycle);
      assert.ok((await controller.relations.getChildren(cycle)).some(node => node.type === 'message'));
    });

    await check('clangd: references grouped with snippets and call-site preview', async () => {
      await controller.references.lookup(leaf);
      const group = controller.references.groups.find(node => node.uri.toString() === document.uri.toString());
      assert.ok(group);
      const children = await controller.references.getChildren(group);
      const reference = children.find(node => node.range.start.line === call.range.start.line);
      assert.ok(reference.snippet.includes('leaf(request.value)'));
      await controller.selectTarget(reference);
      assert.equal(controller.preview.current.mode, '引用现场');
      assert.equal(controller.preview.current.range.start.line, call.range.start.line);
      const count = controller.references.groups.length;
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await controller.follow();
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
      const preview = new ContextView(extension.extensionUri, {
        definitions: sourceUri => sourceUri.toString() === main.uri.toString() ? delayed.promise : Promise.resolve([process])
      }, () => {});
      const old = preview.definition({ ...leaf, uri: main.uri });
      await preview.definition(process);
      delayed.resolve([leaf]); await old;
      assert.equal(preview.current.range.start.line, process.range.start.line);
      preview.dispose();
    });

    await check('Context: multiple definitions require an explicit candidate', async () => {
      const preview = new ContextView(extension.extensionUri, { definitions: async () => [leaf, process] }, () => {});
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
      assert.equal(controller.relations.stale, true);
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
      await vscode.commands.executeCommand('sourceReader.open');
      await sleep(800);
      assert.ok(controller.preview.view, 'Context webview resolved');
    });
    completed = true;
  } finally {
    await config.update('autoPreview', oldAutoPreview, vscode.ConfigurationTarget.Workspace);
    await config.update('autoRelation', oldAutoRelation, vscode.ConfigurationTarget.Workspace);
    if (process.env.SOURCE_READER_REPORT) {
      fs.mkdirSync(path.dirname(process.env.SOURCE_READER_REPORT), { recursive: true });
      fs.writeFileSync(process.env.SOURCE_READER_REPORT, JSON.stringify({
        vscode: vscode.version, platform: process.platform, completed, results, passed: results.filter(result => result.passed).length,
        skipped: results.filter(result => result.skipped).length
      }, null, 2));
    }
  }
  console.log(`${results.filter(result => result.passed).length} extension-host checks passed; ${results.filter(result => result.skipped).length} skipped.`);
}

module.exports = { run };
