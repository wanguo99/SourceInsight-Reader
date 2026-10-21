'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const { Observable } = require('../src/domain/observable');
const { queryResult, symbol } = require('../src/domain/model');
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function indexFixture(t) {
  const env = fakeVscode(), events = new Observable(), requests = [];
  let documents = [];
  const catalog = { onDidChange: callback => events.subscribe(callback), documents: () => documents };
  const { LocalIndex } = loadWithVscode('../src/local-index', env.api);
  const index = new LocalIndex(env.context, catalog);
  index.worker = { postMessage() {}, once() {}, terminate() {} };
  index.ready = Promise.resolve(); index.summary = { files: 1, functions: 1, calls: 0 }; index.phase = 'ready';
  index.request = async (action, data) => { requests.push({ action, ...data }); return index.summary; };
  index.watch(); t.after(() => { index.dispose(); events.dispose(); });
  const document = env.document('close.c'); document.languageId = 'c'; documents = [document];
  return { env, index, catalog, document, requests, emit: event => events.emit(event), close() {
    document.isClosed = true; documents = []; events.emit({ kind: 'close', uri: document.uri, document });
  } };
}
test('closing clean source or transient preview documents never schedules index work', t => {
  const s = indexFixture(t);
  s.close(); s.emit({ kind: 'close', uri: s.document.uri, document: s.document });
  assert.equal(s.index.timers.size, 0); assert.equal(s.requests.length, 0); assert.equal(s.index.getStatus().busy, false);
});
test('closing an indexed dirty buffer restores disk once, without a document-close feedback loop', async t => {
  const s = indexFixture(t); s.document.isDirty = true; s.document.version++;
  await s.index.syncDocument(s.document.uri); assert.equal(s.requests.length, 1); assert.equal(s.requests[0].dirty, true);
  let closes = 0;
  s.index.onDidChange(() => { if (++closes < 5) s.emit({ kind: 'close', uri: s.document.uri, document: s.document }); });
  s.close(); await sleep(850);
  assert.equal(s.requests.length, 2); assert.equal(s.requests[1].dirty, false); assert.equal(s.requests[1].file.text, undefined);
  assert.equal(s.index.timers.size, 0); assert.equal(s.index.getStatus().busy, false);
});
async function controllerFixture(t) {
  const env = fakeVscode(), tabs = new env.api.EventEmitter();
  env.api.window.tabGroups = { all: [], onDidChangeTabs: tabs.event };
  const document = env.document('main.c'); document.languageId = 'c';
  const editor = await env.api.window.showTextDocument(document);
  env.api.window.tabGroups.all = [{ tabs: [{ input: { uri: document.uri } }] }];
  const { ReadingController } = loadWithVscode('../src/extension', env.api);
  const controller = new ReadingController(env.context); t.after(() => { controller.dispose(); tabs.dispose(); });
  controller.language.symbols = async () => [];
  const root = symbol({ name: 'first', uri: document.uri, selectionRange: new env.api.Range(0, 4, 0, 9) });
  controller.relationEngine.prepare = async () => queryResult([root], 'local', 'ready');
  controller.relationEngine.calls = async () => queryResult([], 'local', 'empty');
  await tick(); await controller.follow.acceptEditor(editor);
  await controller.relations.setRoot(root.location); await controller.preview.show({ uri: document.uri, range: new env.api.Range(0, 4, 0, 9) });
  return { env, tabs, controller, document, editor, root, async closeTabs() {
    env.api.window.activeTextEditor = undefined; env.api.window.visibleTextEditors = []; env.api.window.tabGroups.all = [];
    env.events.active.fire(undefined); tabs.fire({ opened: [], closed: [], changed: [] }); await tick();
  } };
}
test('closing the final tab clears automatic reading targets and cancels scheduled index-triggered refresh', async t => {
  const s = await controllerFixture(t), app = s.controller; let roots = 0, opened = 0;
  app.relations.setRoot = async () => { roots++; }; const original = s.env.api.workspace.openTextDocument;
  s.env.api.workspace.openTextDocument = async uri => { opened++; return original(uri); };
  app.localIndex.emitter.fire(s.document.uri); await s.closeTabs();
  app.localIndex.emitter.fire(s.document.uri); app.localIndex.emitter.fire(s.document.uri); await sleep(250);
  assert.equal(roots, 0); assert.equal(opened, 0); assert.equal(app.session.editor, undefined);
  assert.equal(app.relations.source, undefined); assert.equal(app.relations.root, undefined); assert.equal(app.relations.rootState.status, 'idle');
  assert.equal(app.preview.current, undefined); assert.equal(app.symbols.uri, undefined);
});
test('focusing a webview with a source tab still open preserves the reading target', async t => {
  const s = await controllerFixture(t);
  s.env.api.window.activeTextEditor = undefined; s.env.events.active.fire(undefined); await tick();
  assert.equal(s.controller.session.editor, s.editor); assert.equal(s.controller.relations.root.id, s.root.id);
});
test('late root preparation cannot resurrect a closed session; reopening a source resumes following', async t => {
  const s = await controllerFixture(t), app = s.controller; let resolve;
  app.relationEngine.prepare = () => new Promise(done => { resolve = done; });
  const pending = app.relations.setRoot(s.root.location); await s.closeTabs();
  resolve(queryResult([s.root], 'local', 'ready')); await pending; assert.equal(app.relations.root, undefined);
  app.relationEngine.prepare = async () => queryResult([s.root], 'local', 'ready');
  s.env.api.window.tabGroups.all = [{ tabs: [{ input: { uri: s.document.uri } }] }];
  s.env.api.window.activeTextEditor = s.editor; s.env.settings.set('sourceInsightReader.autoRelation', true);
  await app.follow.acceptEditor(s.editor); await app.follow.follow(); assert.equal(app.relations.root.id, s.root.id);
});
test('closing during a dirty update still restores the disk snapshot exactly once', async t => {
  const s = indexFixture(t); s.document.isDirty = true; let complete;
  s.index.request = async (action, data) => {
    s.requests.push({ action, ...data });
    if (s.requests.length === 1) return new Promise(resolve => { complete = resolve; });
    return s.index.summary;
  };
  const updating = s.index.syncDocument(s.document.uri); await tick(); s.close();
  complete(s.index.summary); await updating; await sleep(450);
  assert.equal(s.requests.length, 2); assert.equal(s.requests[1].dirty, false);
  s.emit({ kind: 'close', uri: s.document.uri, document: s.document }); assert.equal(s.index.timers.size, 0);
});
test('dirty buffers included by the initial scan are restored on close', async t => {
  const s = indexFixture(t); s.document.isDirty = true;
  s.catalog.list = async () => [s.document.uri]; await s.index.scan();
  assert.equal(s.requests[0].action, 'scan'); assert.equal(s.requests[0].files[0].text, s.document.getText());
  s.close(); await sleep(450); assert.equal(s.requests.length, 2); assert.equal(s.requests[1].dirty, false);
});
test('watcher updates cache the dirty document version; closing after save causes no redundant update', async t => {
  const s = indexFixture(t); s.document.isDirty = true; s.document.version++;
  s.emit({ kind: 'edit', uri: s.document.uri, document: s.document }); await sleep(450);
  assert.equal(s.requests.length, 1);
  await s.index.syncDocument(s.document.uri); await s.index.syncDocument(s.document.uri); assert.equal(s.requests.length, 1);
  s.document.isDirty = false; s.emit({ kind: 'save', uri: s.document.uri, document: s.document }); await sleep(450);
  assert.equal(s.requests.length, 2); s.close(); assert.equal(s.index.timers.size, 0);
});
test('the last tab closing clears reading even before VS Code clears activeTextEditor', async t => {
  const s = await controllerFixture(t);
  s.env.api.window.tabGroups.all = []; s.tabs.fire({ opened: [], closed: [], changed: [] }); await tick();
  assert.equal(s.controller.session.editor, undefined); assert.equal(s.controller.relations.rootState.status, 'idle');
});
test('closing a dirty document with a pending file deletion preserves the remove operation', async t => {
  const s = indexFixture(t); s.document.isDirty = true; await s.index.syncDocument(s.document.uri);
  s.emit({ kind: 'delete', uri: s.document.uri }); s.close(); await sleep(450);
  assert.equal(s.requests.length, 2); assert.equal(s.requests[1].action, 'remove'); assert.equal(s.index.timers.size, 0);
});
test('a late edge query from the closed session cannot remove the reopened session pending request', async t => {
  const { RelationSession } = require('../src/features/relation-session');
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };
  const root = symbol({ name: 'main', uri: 'file:///project/main.c', selectionRange: range });
  let oldDone, newDone;
  const engine = { revision: () => 'same', prepare: async () => queryResult([root], 'local', 'ready'),
    calls: () => new Promise(resolve => { oldDone = resolve; }) };
  const session = new RelationSession(engine); t.after(() => session.dispose());
  await session.setRoot(root.location); const old = session.load(root, 'incoming'); await tick();
  session.clear(); await session.setRoot(root.location);
  engine.calls = () => new Promise(resolve => { newDone = resolve; });
  const current = session.load(root, 'incoming'); await tick();
  oldDone(queryResult([], 'local', 'empty')); await old; assert.equal(session.pending.size, 1);
  newDone(queryResult([], 'local', 'empty')); await current; assert.equal(session.pending.size, 0); assert.equal(session.edgeState(root, 'incoming').status, 'empty');
});

test('manual rebuild on a cold index performs a single forced scan', async t => {
  const env = fakeVscode(); env.api.workspace.findFiles = async () => []; const { LocalIndex } = loadWithVscode('../src/local-index', env.api);
  const index = new LocalIndex(env.context, {}); t.after(() => index.dispose()); let starts = 0, scans = 0;
  index.start = async force => { starts++; assert.equal(force, true); };
  index.scan = async () => { scans++; };
  await index.refresh(true); assert.equal(starts, 1); assert.equal(scans, 0);
});

test('C index updates leave Java and Python Relation roots and semantic caches untouched', async t => {
  const s = await controllerFixture(t), app = s.controller;
  let invalidations = 0, refreshes = 0;
  app.relationEngine.invalidate = () => { invalidations++; };
  app.relations.setRoot = async () => { refreshes++; };
  for (const extension of ['java', 'py']) {
    app.relations.source = { uri: `file:///project/main.${extension}`, range: s.root.location.range };
    app.localIndex.emitter.fire(s.document.uri);
  }
  await sleep(200);
  assert.equal(invalidations, 0); assert.equal(refreshes, 0);
});
