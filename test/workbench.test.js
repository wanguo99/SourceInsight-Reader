'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const { normalizeSymbols, filterSymbols, locationKey } = require('../src/core');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup() {
  const env = fakeVscode(); const cache = new Map();
  return { ...env, load: file => loadWithVscode(require.resolve(file), env.api, cache),
    location: (doc, line = 0) => ({ uri: doc.uri, range: new env.api.Range(line, 4, line, 9), name: 'symbol' }) };
}

test('reference filtering supports both source text and file paths while preserving the full session', async () => {
  const env = setup(); const { ReferencesTree } = env.load('../src/trees');
  const a = env.document('a.cpp', 'int alpha = 1;\nint beta = alpha;\n'), b = env.document('b.cpp', 'int gamma = 2;\n');
  const references = new ReferencesTree({ references: async () => [env.location(a, 0), env.location(a, 1), env.location(b)] });
  await references.lookup(env.location(a));
  await references.filter('BETA');
  assert.equal(references.allVisibleReferences().length, 1);
  assert.equal(references.allVisibleReferences()[0].range.start.line, 1);
  assert.equal(references.groups.length, 2);
  await references.filter('b.cpp');
  assert.equal(references.allVisibleReferences()[0].uri.toString(), b.uri.toString());
  await references.filter(''); assert.equal(references.allVisibleReferences().length, 3);
  await references.filter('missing'); assert.equal(references.allVisibleReferences().length, 0);
  references.dispose();
});

test('a delayed reference filter cannot replace a newer query session', async () => {
  const env = setup(); const { ReferencesTree } = env.load('../src/trees');
  const a = env.document('a.cpp', 'int alpha;'), b = env.document('b.cpp', 'int alpha;');
  const refs = new ReferencesTree({ references: async uri => [env.location(uri.toString() === a.uri.toString() ? a : b)] });
  await refs.lookup(env.location(a));
  const delayed = deferred(); const open = env.api.workspace.openTextDocument;
  env.api.workspace.openTextDocument = uri => uri.toString() === a.uri.toString() ? delayed.promise : open(uri);
  const pending = refs.filter('alpha');
  await refs.lookup(env.location(b)); delayed.resolve(a); await pending;
  assert.equal(refs.visibleGroups.length, 1); assert.equal(refs.visibleGroups[0].uri.toString(), b.uri.toString());
  refs.dispose();
});

test('reference history retains source identities and bounds memory without retaining old result sets', async () => {
  const env = setup(); const { ReferencesTree } = env.load('../src/trees'); const doc = env.document('a.cpp');
  const refs = new ReferencesTree({ references: async () => [] });
  for (let line = 0; line < 25; line++) await refs.lookup(env.location(doc, line));
  assert.equal(refs.recentSources.length, 20);
  assert.equal(refs.recentSources[0].range.start.line, 24);
  await refs.lookup(env.location(doc, 24)); assert.equal(refs.recentSources.length, 20);
  refs.clear(); assert.equal(refs.recentSources.length, 20); assert.deepEqual(refs.groups, []); refs.dispose();
});

test('reference next/previous follows filtered results in main editor and stops for stale data', async () => {
  const env = setup(); const { ReadingController } = env.load('../src/extension');
  const a = env.document('a.cpp'), b = env.document('b.cpp');
  const editor = await env.api.window.showTextDocument(a); const controller = new ReadingController(env.context);
  await controller.acceptEditor(editor);
  controller.language.references = async () => [env.location(b, 0), env.location(b, 1)];
  await controller.references.lookup(env.location(a)); await controller.references.filter('b.cpp');
  await controller.moveReference(1); assert.equal(controller.currentReference.range.start.line, 0);
  await controller.moveReference(1); assert.equal(controller.currentReference.range.start.line, 1);
  await controller.moveReference(1); assert.equal(controller.currentReference.range.start.line, 0);
  await controller.moveReference(-1); assert.equal(controller.currentReference.range.start.line, 1);
  assert.equal(controller.mainEditor.document.uri.toString(), b.uri.toString());
  controller.references.markStale(); await controller.moveReference(1);
  assert.equal(controller.currentReference.range.start.line, 1); controller.dispose();
});

test('Enter opens the selected relationship even when Context is locked on a different file', async () => {
  const env = setup(); const { ReadingController } = env.load('../src/extension');
  const a = env.document('a.cpp'), b = env.document('b.cpp');
  const editor = await env.api.window.showTextDocument(a); const controller = new ReadingController(env.context);
  await controller.acceptEditor(editor);
  await controller.preview.show(env.location(a)); controller.preview.toggleLock();
  controller.relationView.selection = [{ type: 'relation', ...env.location(b) }];
  await env.commands.get('sourceInsightInspired.openSelection')('relations');
  assert.equal(controller.mainEditor.document.uri.toString(), b.uri.toString());
  assert.equal(controller.preview.current.uri.toString(), a.uri.toString()); controller.dispose();
});

test('global-symbol picker discards old search results and previews without navigating', async () => {
  const env = setup(); const { ReadingPickers } = env.load('../src/pickers');
  const a = env.document('a.cpp'); const delayed = deferred(); const opened = [], previews = [];
  const symbol = name => ({ name, location: env.location(a), containerName: 'demo' });
  const pickers = new ReadingPickers({ workspaceSymbols: query => query === 'old' ? delayed.promise : Promise.resolve([symbol('new')]) },
    async source => { opened.push(source); }, async source => { previews.push(source); }, error => { throw error; });
  pickers.symbols('old'); await sleep(220); const picker = env.quicks[0];
  picker.value = 'new'; await sleep(220);
  delayed.resolve([symbol('old')]); await sleep(0);
  assert.equal(picker.items[0].label, 'new'); picker.activate(0); await sleep(0);
  assert.equal(previews.length, 1); assert.equal(opened.length, 0);
  picker.accept(0); await sleep(0); assert.equal(opened.length, 1); assert.equal(picker.disposed, true); pickers.dispose();
});

test('file picker honors reading include/exclude rules and supports closing during a scan', async () => {
  const env = setup(); const { ReadingPickers } = env.load('../src/pickers');
  const a = env.document('src/中文 file.cpp'), excluded = env.document('node_modules/a.cpp'), other = env.document('README.md');
  env.settings.set('sourceInsightInspired.files.include', ['**/*.cpp']);
  env.api.workspace.findFiles = async () => [a.uri, excluded.uri, other.uri];
  const pickers = new ReadingPickers({}, async () => {}, async () => {}, error => { throw error; });
  await pickers.files(); assert.equal(env.quicks[0].items.length, 1); assert.equal(env.quicks[0].items[0].label, '中文 file.cpp');
  const delayed = deferred(); env.api.workspace.findFiles = () => delayed.promise;
  const scan = pickers.files(); pickers.close(); delayed.resolve([a.uri]); await scan;
  assert.equal(env.quicks[1].disposed, true); assert.deepEqual(env.quicks[1].items, []); pickers.dispose();
});

test('Context modes show type definitions or the enclosing function without changing the main editor', async () => {
  const env = setup(); const { ReadingController } = env.load('../src/extension'); const doc = env.document('a.cpp');
  const editor = await env.api.window.showTextDocument(doc); editor.selection = new env.api.Selection(0, 14, 0, 14);
  const controller = new ReadingController(env.context); await controller.acceptEditor(editor);
  controller.symbols.nodes = normalizeSymbols([{ name: 'first', kind: 11, range: new env.api.Range(0, 0, 1, 0), selectionRange: new env.api.Range(0, 4, 0, 9) }], doc.uri);
  env.settings.set('sourceInsightInspired.autoPreview', true); env.settings.set('sourceInsightInspired.contextMode', 'type');
  let typeQuery = false; controller.language.definitions = async (uri, position, type) => { typeQuery = type; return [env.location(doc)]; };
  await controller.follow(); assert.equal(typeQuery, true);
  env.settings.set('sourceInsightInspired.contextMode', 'enclosing'); await controller.follow();
  assert.equal(controller.preview.current.mode, '包含函数'); assert.equal(env.api.window.activeTextEditor, editor); controller.dispose();
});

test('Context can browse beyond the initial excerpt and paging cannot bypass a lock', async () => {
  const env = setup(); const { ContextView } = env.load('../src/context');
  const doc = env.document('a.cpp', Array.from({ length: 80 }, (_, index) => `int value${index};`).join('\r\n'));
  const preview = new ContextView(env.context.extensionUri, {}, () => {});
  await preview.show(env.location(doc, 30)); await preview.handleMessage({ action: 'later' });
  assert.equal(preview.current.range.start.line, 50);
  preview.toggleLock(); const pinned = locationKey(preview.current);
  await preview.handleMessage({ action: 'earlier' }); assert.equal(locationKey(preview.current), pinned);
  preview.dispose();
});

test('empty relation results are retried; direction switch preserves the exact root', async () => {
  const env = setup(); const { RelationTree } = env.load('../src/trees'); const doc = env.document('a.cpp');
  const root = { ...env.location(doc), selectionRange: env.location(doc).range };
  let calls = 0, prepares = 0;
  const relation = new RelationTree({ prepare: async () => { prepares++; return [root]; }, calls: async () => { calls++; return []; } });
  await relation.setRoot(env.location(doc)); const original = relation.root;
  await relation.getChildren(original); await relation.getChildren(original); assert.equal(calls, 2);
  relation.switchDirection('outgoing'); assert.equal(relation.root, original); assert.equal(prepares, 1);
  await relation.getChildren(original); assert.equal(calls, 3); relation.dispose();
});

test('all-symbol mode includes variables while default function mode keeps them hidden', () => {
  const env = setup(); const doc = env.document('a.cpp');
  const nodes = normalizeSymbols([{ name: 'value', kind: 12, range: env.location(doc).range }], doc.uri);
  assert.deepEqual(filterSymbols(nodes), []);
  assert.equal(filterSymbols(nodes, '', 'position', undefined, true)[0].name, 'value');
});

test('reading history includes native file switches and command-driven selection jumps', async () => {
  const env = setup(); const { ReadingController } = env.load('../src/extension');
  const a = env.document('a.cpp'), b = env.document('b.cpp');
  const editor = await env.api.window.showTextDocument(a); const controller = new ReadingController(env.context);
  await controller.acceptEditor(editor);
  editor.selection = new env.api.Selection(0, 12, 0, 12);
  env.events.selection.fire({ textEditor: editor, kind: env.api.TextEditorSelectionChangeKind.Command });
  await controller.navigate('back'); assert.equal(controller.mainEditor.selection.start.character, 0);
  const native = await env.api.window.showTextDocument(b); await controller.acceptEditor(native);
  await controller.navigate('back'); assert.equal(controller.mainEditor.document.uri.toString(), a.uri.toString());
  await controller.navigate('forward'); assert.equal(controller.mainEditor.document.uri.toString(), b.uri.toString());
  controller.dispose();
});

test('a slow earlier open cannot navigate over a later target', async () => {
  const env = setup(); const { ReadingController } = env.load('../src/extension');
  const a = env.document('a.cpp'), b = env.document('b.cpp'), c = env.document('c.cpp');
  const editor = await env.api.window.showTextDocument(a); const controller = new ReadingController(env.context);
  await controller.acceptEditor(editor);
  const delayed = deferred(), open = env.api.workspace.openTextDocument;
  env.api.workspace.openTextDocument = uri => uri.toString() === b.uri.toString() ? delayed.promise : open(uri);
  const old = controller.openTarget(env.location(b));
  await controller.openTarget(env.location(c)); delayed.resolve(b); await old;
  assert.equal(controller.mainEditor.document.uri.toString(), c.uri.toString()); controller.dispose();
});
