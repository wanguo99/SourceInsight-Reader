'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const { RelationSession } = require('../src/features/relation-session');
const { symbol, queryResult } = require('../src/domain/model');
function setup(mode = 'horizontalGraph') {
  const env = fakeVscode(); env.settings.set('sourceInsightReader.relationView', mode);
  const { RelationPane } = loadWithVscode('../src/relation-pane', env.api);
  const item = (name, line) => symbol({ name, uri: 'file:///project/calls.c', selectionRange: { start: { line, character: 4 }, end: { line, character: 8 } } });
  const root = item('callee', 0), caller = item('caller', 3), leaf = item('leaf', 8);
  const sites = [4, 5].map(line => ({ uri: caller.location.uri, range: { start: { line, character: 2 }, end: { line, character: 8 } } }));
  let revision = 0, calls = 0;
  const engine = { revision: () => String(revision), invalidate: () => revision++, prepare: async () => queryResult([root], 'local', 'ready'),
    calls: async (node, direction) => { calls++; return queryResult([{ symbol: direction === 'outgoing' ? leaf : node.name === root.name ? caller : root, sites }], 'local', 'ready'); } };
  const model = new RelationSession(engine), updates = [], opened = [], selected = [], errors = [];
  const webview = { postMessage: async state => updates.push(state) };
  const pane = new RelationPane(model, () => webview, node => opened.push(node), error => errors.push(error));
  pane.onDidChangeSelection(event => selected.push(event.selection[0]));
  const settle = async () => { await pane.publish(); await model.whenIdle(); await new Promise(done => setImmediate(done)); };
  return { env, root, caller, leaf, sites, engine, model, pane, updates, opened, selected, errors, settle, calls: () => calls, dispose() { pane.dispose(); model.dispose(); } };
}
test('horizontal graph queries one level in both directions; click previews exact caller site and double click opens definition', async t => {
  const s = setup(); t.after(() => s.dispose()); await s.model.setRoot(s.root.location); await s.settle();
  const graph = s.updates.at(-1).graph; assert.equal(s.calls(), 2);
  assert.equal(graph.incomingCount, 1); assert.equal(graph.outgoingCount, 1); assert.equal(graph.incoming[0].siteCount, 2);
  const row = graph.incoming[0]; await s.pane.handleMessage({ action: 'relation.select', id: row.id });
  assert.equal(s.selected[0].range.start.line, 4); assert.equal(s.opened.length, 0);
  assert.deepEqual(row.siteLines, [{ line: 5, file: 'calls.c' }, { line: 6, file: 'calls.c' }]);
  await s.pane.handleMessage({ action: 'relation.site', id: row.id, index: 1 });
  assert.equal(s.selected.at(-1).range.start.line, 5);
  const count = s.selected.length;
  await s.pane.handleMessage({ action: 'relation.site', id: row.id, index: 100 });
  assert.equal(s.selected.length, count);
  await s.pane.handleMessage({ action: 'relation.open', id: row.id }); assert.equal(s.opened[0].range.start.line, 3);
});
test('outline expands lazily, detects cycles and expands individual call sites', async t => {
  const s = setup('outline'); t.after(() => s.dispose()); await s.model.setRoot(s.root.location); await s.settle();
  assert.equal(s.calls(), 1); let caller = s.updates.at(-1).rows[0].children.find(row => row.label === 'caller');
  await s.pane.handleMessage({ action: 'relation.toggle', id: caller.id }); await s.settle();
  caller = s.updates.at(-1).rows[0].children.find(row => row.label === 'caller');
  assert(caller.children.some(row => row.label === '↻ callee')); assert.equal(s.calls(), 2);
  const sites = caller.children.find(row => row.type === 'sites'); await s.pane.handleMessage({ action: 'relation.toggle', id: sites.id }); await s.settle();
  const expanded = s.updates.at(-1).rows[0].children[0].children.find(row => row.type === 'sites');
  assert.equal(expanded.children.length, 2); await s.pane.handleMessage({ action: 'relation.select', id: expanded.children[1].id }); assert.equal(s.selected.at(-1).range.start.line, 5);
});
test('stale rows cannot navigate and refresh footer resets retry state without rebuilding index', async t => {
  const s = setup(); t.after(() => s.dispose()); await s.model.setRoot(s.root.location); await s.settle();
  const old = s.updates.at(-1).graph.incoming[0].id; s.model.invalidate(); await s.settle();
  await s.pane.handleMessage({ action: 'relation.site', id: old, index: 0 }); assert.equal(s.selected.length, 0);
  await s.pane.handleMessage({ action: 'relation.open', id: old }); assert.equal(s.opened.length, 0); assert.equal(s.updates.at(-1).stale, true);
  let refreshes = 0; s.env.commands.set('sourceInsightReader.refreshRelations', async () => { refreshes++; await s.model.refresh(); });
  await s.pane.handleMessage({ action: 'relation.refresh' }); await s.settle(); assert.equal(refreshes, 1); assert.equal(s.model.rootState.status, 'ready');
});
test('available direction publishes while the other query is pending, and refresh retains usable edges on failure', async t => {
  const s = setup(); t.after(() => s.dispose()); let resolve;
  s.engine.calls = async (node, direction) => direction === 'incoming' ? queryResult([{ symbol: s.caller, sites: s.sites }], 'local', 'ready') : new Promise(done => { resolve = done; });
  await s.model.setRoot(s.root.location); await new Promise(done => setImmediate(done));
  const partial = s.updates.at(-1).graph; assert.equal(partial.incomingCount, 1); assert.equal(partial.outgoingStatus.loading, true);
  resolve(queryResult([], 'languageService', 'timeout', '', ['timeout'])); await s.settle(); assert.equal(s.updates.at(-1).graph.incomingCount, 1);
  s.engine.calls = async () => queryResult([], 'none', 'error', '', ['offline']); await s.model.refresh(); await s.settle();
  assert.equal(s.model.edgeState(s.root, 'incoming').status, 'retained'); assert.equal(s.updates.at(-1).graph.incomingCount, 1);
});
test('root lock and obsolete asynchronous root/edge completions cannot replace newer state', async t => {
  const s = setup(); t.after(() => s.dispose()); let resolve;
  s.engine.prepare = () => new Promise(done => { resolve = done; }); const old = s.model.setRoot(s.root.location);
  s.engine.prepare = async () => queryResult([s.caller], 'local', 'ready'); await s.model.setRoot(s.caller.location);
  resolve(queryResult([s.root], 'local', 'ready')); await old; assert.equal(s.model.root, s.caller);
  s.model.toggleLock(); await s.model.setRoot(s.root.location, { manual: true }); assert.equal(s.model.root, s.caller);
  s.model.toggleLock(); await s.settle(); s.pane.subscription.dispose(); s.engine.invalidate(); let complete;
  s.engine.calls = () => new Promise(done => { complete = done; }); const pending = s.model.load(s.caller, 'incoming');
  await new Promise(done => setImmediate(done)); s.engine.invalidate(); s.model.invalidate(); complete(queryResult([{ symbol: s.root, sites: [] }], 'local', 'ready')); await pending;
  assert.equal(s.model.edgeState(s.caller, 'incoming').status, 'stale');
});
test('graph bounds each side to 200 without querying grandchildren', async t => {
  const s = setup(); t.after(() => s.dispose());
  s.engine.calls = async () => queryResult(Array.from({ length: 250 }, (_, n) => ({ symbol: { ...s.caller, id: String(n), name: 'caller' + n }, sites: [] })), 'local', 'ready');
  await s.model.setRoot(s.root.location); await s.settle(); const state = s.updates.at(-1);
  assert.equal(state.graph.incoming.length, 200); assert.equal(state.graph.outgoing.length, 200); assert.equal(state.graph.incomingCount, 250); assert.equal(state.truncated, true);
});

test('same-root invalidation retains the diagram and blocks stale positions until successful retry', async t => {
  const s = setup(); t.after(() => s.dispose());
  await s.model.setRoot(s.root.location); await s.settle();
  const oldId = s.updates.at(-1).graph.incoming[0].id;
  s.updates.length = 0;
  s.engine.invalidate(); s.model.invalidate();
  let finish;
  s.engine.prepare = () => new Promise(resolve => { finish = resolve; });
  const pending = s.model.setRoot(s.root.location, { manual: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.model.root.id, s.root.id);
  await s.pane.handleMessage({ action: 'relation.open', id: oldId }); assert.equal(s.opened.length, 0);
  finish(queryResult([s.root], 'local', 'ready')); await pending; await s.settle();
  assert(s.updates.every(frame => frame.graph.root && frame.graph.incomingCount === 1));
  assert.equal(s.updates.at(-1).stale, false);
  assert.equal(s.updates.at(-1).graph.incoming[0].id, oldId);
  await s.pane.handleMessage({ action: 'relation.open', id: oldId }); assert.equal(s.opened.length, 1);
});

test('identical publications are suppressed and synchronous changes are coalesced', async t => {
  const s = setup(); t.after(() => s.dispose());
  await s.model.setRoot(s.root.location); await s.settle();
  s.updates.length = 0;
  await s.pane.publish(); await s.pane.publish(); assert.equal(s.updates.length, 0);
  s.model.toggleLock(); s.model.toggleLock(); s.model.toggleLock();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.updates.length, 1); assert.equal(s.updates[0].locked, true);
});

test('failed retry keeps invalidated edges visible but never makes their positions usable', async t => {
  const s = setup(); t.after(() => s.dispose());
  await s.model.setRoot(s.root.location); await s.settle();
  s.engine.invalidate(); s.model.invalidate();
  s.engine.calls = async () => queryResult([], 'none', 'error', '', ['offline']);
  await s.model.setRoot(s.root.location, { manual: true }); await s.settle();
  const frame = s.updates.at(-1);
  assert.equal(frame.graph.incomingCount, 1); assert.equal(frame.stale, true);
  await s.pane.handleMessage({ action: 'relation.open', id: frame.graph.incoming[0].id });
  assert.equal(s.opened.length, 0);
});
