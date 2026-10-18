'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const { locationKey } = require('../src/core');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup() {
  const fake = fakeVscode();
  const cache = new Map();
  return { ...fake, load: file => loadWithVscode(require.resolve(file), fake.api, cache),
    location: (document, line) => ({ uri: document.uri, range: new fake.api.Range(line, 4, line, 9), name: `line${line}` }) };
}

test('Context preserves source position, blocks changes while locked and refreshes pinned content', async () => {
  const env = setup();
  const { ContextView } = env.load('../src/context');
  const a = env.document('a.cpp'), b = env.document('b.cpp');
  const editor = await env.api.window.showTextDocument(a);
  const preview = new ContextView(env.context.extensionUri, {}, () => {});
  await preview.show(env.location(b, 1));
  assert.equal(env.api.window.activeTextEditor, editor);
  const pinned = locationKey(preview.current);
  preview.toggleLock(); await preview.show(env.location(a, 0));
  assert.equal(locationKey(preview.current), pinned);
  b.isDirty = true; b.text = b.text.replace('second', 'changed');
  await preview.refresh();
  assert.ok(preview.state.status.includes('未保存'));
  assert.ok(preview.state.lines.some(line => line.text.includes('changed')));
  assert.equal(locationKey(preview.current), pinned);
  preview.dispose();
});

test('Context rejects late definitions, clears failed content and retries empty queries', async () => {
  const env = setup(); const { ContextView } = env.load('../src/context');
  const a = env.document('a.cpp'), b = env.document('b.cpp');
  const delayed = deferred(); let ready = false;
  const preview = new ContextView(env.context.extensionUri, { definitions: uri =>
    uri.toString() === a.uri.toString() ? delayed.promise : Promise.resolve(ready ? [env.location(b, 1)] : []) }, () => {});
  const old = preview.definition(env.location(a, 0));
  await preview.definition(env.location(b, 1));
  assert.equal(preview.current, undefined);
  delayed.resolve([env.location(a, 0)]); await old;
  assert.equal(preview.current, undefined);
  ready = true; await preview.refresh();
  assert.equal(preview.current.uri.toString(), b.uri.toString());
  await preview.show({ ...env.location(b, 1), uri: env.api.Uri.file('/missing') });
  assert.equal(preview.current, undefined); assert.deepEqual(preview.state.lines, []);
  preview.dispose();
});

test('Context multiple definitions wait for selection and lock blocks candidate changes', async () => {
  const env = setup(); const { ContextView } = env.load('../src/context');
  const a = env.document('a.cpp');
  const preview = new ContextView(env.context.extensionUri, { definitions: async () => [env.location(a, 0), env.location(a, 1)] }, () => {});
  await preview.definition(env.location(a, 0));
  assert.equal(preview.current, undefined); assert.equal(preview.state.candidates.length, 2);
  await preview.handleMessage({ action: 'candidate', index: 1 });
  assert.equal(preview.current.range.start.line, 1);
  preview.toggleLock(); await preview.handleMessage({ action: 'candidate', index: 0 });
  assert.equal(preview.current.range.start.line, 1);
  preview.dispose();
});

test('symbol list and references reject late file/session results', async () => {
  const env = setup(); const { SymbolTree, ReferencesTree } = env.load('../src/trees');
  const a = env.document('a.cpp'), b = env.document('b.cpp');
  const delayed = deferred();
  const symbols = new SymbolTree({ symbols: uri => uri.toString() === a.uri.toString() ? delayed.promise : Promise.resolve([]) });
  const old = symbols.load(a.uri); await symbols.load(b.uri); delayed.resolve([{}]); await old;
  assert.equal(symbols.uri.toString(), b.uri.toString()); assert.deepEqual(symbols.nodes, []);
  symbols.dispose();
  const pending = deferred();
  const references = new ReferencesTree({ references: uri => uri.toString() === a.uri.toString() ? pending.promise : Promise.resolve([env.location(b, 1)]) });
  const oldQuery = references.lookup(env.location(a, 0));
  await references.lookup(env.location(b, 1)); pending.resolve([env.location(a, 0)]); await oldQuery;
  assert.equal(references.groups.length, 1); assert.equal(references.groups[0].uri.toString(), b.uri.toString());
  const children = await references.getChildren(references.groups[0]);
  assert.ok(children[0].snippet.includes('second'));
  references.markStale(); assert.equal(references.stale, true);
  references.clear(); assert.deepEqual(references.groups, []); references.dispose();
});

test('Relation respects root lock, stops recursion, and invalidates child requests on edits', async () => {
  const env = setup(); const { RelationTree } = env.load('../src/trees');
  const a = env.document('a.cpp'), b = env.document('b.cpp');
  const item = location => ({ ...location, selectionRange: location.range });
  const root = item(env.location(a, 0)); const delayed = deferred();
  const relations = new RelationTree({ prepare: async uri => [{ ...root, uri }], calls: () => delayed.promise });
  await relations.setRoot(env.location(a, 0)); relations.locked = true;
  await relations.setRoot(env.location(b, 0)); assert.equal(relations.root.uri.toString(), a.uri.toString());
  await relations.setRoot(env.location(b, 0), true); assert.equal(relations.root.uri.toString(), a.uri.toString());
  const pending = relations.getChildren(relations.root);
  relations.markStale(); delayed.resolve([{ from: root, fromRanges: [root.range] }]);
  assert.deepEqual(await pending, []);
  assert.ok((await relations.getChildren(relations.root))[0].label.includes('刷新'));
  relations.locked = false; relations.direction = 'incoming';
  await relations.setRoot(env.location(a, 0));
  const cycle = (await relations.getChildren(relations.root)).find(node => node.cycle);
  assert.ok(cycle); assert.ok((await relations.getChildren(cycle)).some(node => node.type === 'message'));
  relations.dispose();
});

test('controller navigation restores selections and reference preview never changes main file', async () => {
  const env = setup(); const { ReadingController } = env.load('../src/extension');
  const a = env.document('a.cpp'), b = env.document('b.cpp');
  const editor = await env.api.window.showTextDocument(a);
  editor.selection = new env.api.Selection(0, 2, 0, 2);
  const controller = new ReadingController(env.context);
  await controller.acceptEditor(editor);
  await controller.selectTarget({ type: 'reference', ...env.location(b, 1) });
  assert.equal(controller.mainEditor.document.uri.toString(), a.uri.toString());
  await controller.openTarget(env.location(b, 1));
  assert.equal(controller.mainEditor.document.uri.toString(), b.uri.toString());
  await controller.navigate('back');
  assert.equal(controller.mainEditor.document.uri.toString(), a.uri.toString());
  assert.equal(controller.mainEditor.selection.start.character, 2);
  await controller.navigate('forward');
  assert.equal(controller.mainEditor.document.uri.toString(), b.uri.toString());
  controller.dispose();
});

test('file tree excludes configured directories, preserves folders for includes, and ignores symlinks', async () => {
  const env = setup(); const { FileTree } = env.load('../src/trees');
  env.settings.set('sourceReader.files.include', ['**/*.cpp']);
  env.api.workspace.fs.readDirectory = async () => [['src', 2], ['.git', 2], ['node_modules', 2], ['link', 66], ['reader.cpp', 1], ['README.md', 1]];
  const tree = new FileTree(); const [root] = await tree.getChildren();
  assert.deepEqual((await tree.getChildren(root)).map(node => node.name), ['src', 'reader.cpp']);
  tree.dispose();
});

test('automatic following reuses a symbol query and unlocking resumes from the main symbol', async () => {
  const env = setup(); const { ReadingController } = env.load('../src/extension');
  const document = env.document('a.cpp');
  const editor = await env.api.window.showTextDocument(document);
  editor.selection = new env.api.Selection(0, 5, 0, 5);
  const controller = new ReadingController(env.context);
  await controller.acceptEditor(editor);
  env.settings.set('sourceReader.autoPreview', true);
  let queries = 0;
  controller.language.definitions = async () => { queries++; return [env.location(document, 0)]; };
  await controller.follow();
  editor.selection = new env.api.Selection(0, 6, 0, 6);
  await controller.follow();
  assert.equal(queries, 1);
  await controller.preview.show(env.location(document, 1));
  await env.commands.get('sourceReader.toggleContextLock')();
  await env.commands.get('sourceReader.toggleContextLock')();
  await controller.follow();
  assert.equal(queries, 2);
  assert.equal(controller.preview.current.range.start.line, 0);
  controller.dispose();
});
