'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function setup(mode = 'outline') {
  const env = fakeVscode();
  env.settings.set('sourceReader.relationView', mode);
  const { RelationTree } = loadWithVscode('../src/trees', env.api);
  const { RelationPane } = loadWithVscode('../src/relation-pane', env.api);
  const doc = env.document('calls.c');
  const item = (name, line) => ({ name, uri: doc.uri, kind: 11,
    range: new env.api.Range(line, 0, line + 1, 0), selectionRange: new env.api.Range(line, 4, line, 8) });
  const callee = item('callee', 0), caller = item('caller', 3);
  let calls = 0;
  const model = new RelationTree({ prepare: async () => [callee], calls: async (root, direction) => {
    calls++;
    if (direction === 'outgoing') return [{ to: item('leaf', 8), fromRanges: [new env.api.Range(1, 2, 1, 6)] }];
    return [{ from: root.name === 'callee' ? caller : callee, fromRanges: [new env.api.Range(4, 2, 4, 8), new env.api.Range(5, 2, 5, 8)] }];
  } });
  const updates = [], opened = [], selected = [], errors = [];
  const pane = new RelationPane(model, () => ({ async postMessage(value) { updates.push(value); } }), node => opened.push(node), error => errors.push(error));
  pane.onDidChangeSelection(event => selected.push(event.selection[0]));
  const source = { uri: doc.uri, range: callee.selectionRange, name: callee.name };
  return { env, model, pane, updates, opened, selected, errors, source, calls: () => calls, item };
}

test('combined Relation pane expands semantic calls lazily, preserves call sites/cycles and opens the selected location', async () => {
  const s = setup(); await s.model.setRoot(s.source); await s.pane.publish();
  const root = s.updates.at(-1).rows[0], caller = root.children.find(row => row.label === 'caller');
  assert.equal(root.label, 'callee'); assert.equal(root.expanded, true); assert.ok(caller);
  assert.equal(s.calls(), 1);
  await s.pane.handleMessage({ action: 'relation.select', id: caller.id });
  assert.equal(s.selected[0].name, 'caller'); assert.equal(s.updates.at(-1).selectionOnly, true);
  assert.equal(s.selected[0].type, 'callsite'); assert.equal(s.selected[0].range.start.line, 4);
  assert.equal(s.opened.length, 0);
  await s.pane.handleMessage({ action: 'relation.open', id: caller.id });
  assert.equal(s.opened[0].range.start.line, 3);
  const currentCaller = s.updates.at(-1).rows[0].children.find(row => row.label === 'caller');
  await s.pane.handleMessage({ action: 'relation.toggle', id: currentCaller.id });
  const expanded = s.updates.at(-1).rows[0].children.find(row => row.label === 'caller');
  assert.equal(expanded.expanded, true); assert.ok(expanded.children.some(row => row.label === '调用位置（2）'));
  assert.ok(expanded.children.some(row => row.label === '↻ callee'));
  const count = s.calls();
  await s.pane.handleMessage({ action: 'relation.toggle', id: expanded.id });
  const collapsed = s.updates.at(-1).rows[0].children.find(row => row.label === 'caller');
  await s.pane.handleMessage({ action: 'relation.toggle', id: collapsed.id });
  assert.equal(s.calls(), count);
  assert.equal(s.errors.length, 0); s.pane.dispose(); s.model.dispose();
});

test('Relation refresh discards obsolete row messages and routes footer controls to existing commands', async () => {
  const s = setup(); await s.model.setRoot(s.source); await s.pane.publish();
  const obsolete = s.updates.at(-1).rows[0].children[0].id;
  s.model.markStale(); await s.pane.publish();
  await s.pane.handleMessage({ action: 'relation.open', id: obsolete }); assert.equal(s.opened.length, 0);
  assert.equal(s.updates.at(-1).stale, true);
  const called = [];
  for (const [action, command] of [['incoming','incoming'], ['outgoing','outgoing'], ['lock','toggleRelationLock'], ['refresh','refreshRelations']]) {
    s.env.commands.set(`sourceReader.${command}`, () => called.push(command));
    await s.pane.handleMessage({ action: `relation.${action}` });
  }
  assert.deepEqual(called, ['incoming', 'outgoing', 'toggleRelationLock', 'refreshRelations']);
  s.pane.dispose(); s.model.dispose();
});

test('the reading container has one webview with Context left and Relation right, rather than two draggable native views', async () => {
  const env = fakeVscode(), manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const views = manifest.contributes.views.sourceReaderPanel;
  assert.equal(views.length, 1); assert.equal(views[0].type, 'webview'); assert.equal(views[0].id, 'sourceReader.context');
  const { ContextView } = loadWithVscode('../src/context', env.api);
  const view = new ContextView(env.context.extensionUri, {}, () => {});
  const disposable = () => new env.api.Disposable();
  const webview = { options: {}, cspSource: 'vscode-resource:', asWebviewUri: uri => uri.toString(),
    onDidReceiveMessage: disposable, postMessage() {} };
  view.resolveWebviewView({ webview, onDidChangeVisibility: disposable, onDidDispose: disposable });
  assert.ok(webview.html.indexOf('id="context-pane"') < webview.html.indexOf('id="reading-splitter"'));
  assert.ok(webview.html.indexOf('id="reading-splitter"') < webview.html.indexOf('id="relation-pane"'));
  assert.ok(webview.html.indexOf('id="relation-tree"') < webview.html.indexOf('id="relation-incoming"'));
  const heading = /<h2 class="pane-title context-heading">[\s\S]*?<\/h2>/.exec(webview.html)[0];
  assert.match(heading, /id="status"/); assert.match(heading, /id="path"/);
  assert.match(webview.html, /reading-panel\.css/); assert.match(webview.html, /aria-orientation="vertical"/);
  view.dispose();
});

test('a late old call query cannot replace a newer Relation root', async () => {
  const s = setup(); let resolve;
  const pending = new Promise(done => { resolve = done; });
  const next = s.item('new-root', 20);
  s.model.language.calls = async item => item.name === 'callee' ? pending : [];
  s.model.language.prepare = async (uri, point) => point.line === 20 ? [next] : [s.item('callee', 0)];
  await s.model.setRoot(s.source);
  const old = s.pane.publish();
  await s.model.setRoot({ uri: next.uri, range: next.selectionRange }); await s.pane.publish();
  resolve([]); await old;
  assert.equal(s.updates.at(-1).rows[0].label, 'new-root');
  s.pane.dispose(); s.model.dispose();
});

test('horizontal graph queries both immediate directions, preserves sites, and switches to Outline without changing root', async () => {
  const s = setup('horizontalGraph');
  await s.model.setRoot(s.source); await s.pane.publish();
  const state = s.updates.at(-1), root = s.model.root;
  assert.equal(state.viewMode, 'horizontalGraph'); assert.equal(state.graph.root.label, 'callee');
  assert.equal(state.graph.incoming[0].label, 'caller'); assert.equal(state.graph.outgoing[0].label, 'leaf');
  assert.equal(state.graph.incoming[0].siteCount, 2); assert.equal(state.graph.outgoing[0].siteCount, 1);
  assert.equal(state.graph.incomingCount, 1); assert.equal(state.graph.outgoingCount, 1);
  assert.equal(s.calls(), 2); assert.equal(s.model.direction, 'incoming');
  await s.pane.handleMessage({ action: 'relation.select', id: state.graph.outgoing[0].id });
  assert.equal(s.selected.at(-1).name, 'leaf');
  assert.equal(s.selected.at(-1).type, 'callsite');
  assert.equal(s.selected.at(-1).range.start.line, 1); // call in current function
  assert.equal(s.opened.length, 0);
  await s.pane.handleMessage({ action: 'relation.select', id: state.graph.incoming[0].id });
  assert.equal(s.selected.at(-1).range.start.line, 4); // call inside caller
  assert.equal(s.pane.selection[0].range.start.line, 3); // retain definition for explicit open
  assert.equal(s.opened.length, 0);
  const openedCount = s.opened.length;
  await s.pane.handleMessage({ action: 'relation.sites', id: state.graph.incoming[0].id });
  assert.equal(s.selected.at(-1).type, 'callsite'); assert.equal(s.selected.at(-1).range.start.line, 4);
  assert.equal(s.opened.length, openedCount); // call-site picker keeps Context preview
  assert.equal(s.model.root, root); assert.equal(s.calls(), 2);
  s.model.locked = true; s.env.settings.set('sourceReader.relationView', 'outline'); await s.pane.publish();
  assert.equal(s.updates.at(-1).rows[0].label, 'callee'); assert.equal(s.updates.at(-1).viewMode, 'outline');
  assert.equal(s.model.root, root); assert.equal(s.model.locked, true);
  s.env.settings.set('sourceReader.relationView', 'horizontalGraph'); await s.pane.publish();
  assert.equal(s.updates.at(-1).graph.root.label, 'callee'); assert.equal(s.model.root, root);
  assert.equal(s.calls(), 2); assert.equal(s.errors.length, 0);
  s.pane.dispose(); s.model.dispose();
});

test('horizontal graph keeps the available side when the other direction fails and rejects delayed previous roots', async () => {
  const s = setup('horizontalGraph');
  s.model.language.calls = async (root, direction) => {
    if (direction === 'outgoing') throw new Error('outgoing unavailable');
    return [{ from: s.item('caller', 3), fromRanges: [new s.env.api.Range(4, 2, 4, 8)] }];
  };
  await s.model.setRoot(s.source); await s.pane.publish();
  assert.equal(s.updates.at(-1).graph.incoming[0].label, 'caller');
  assert.match(s.updates.at(-1).graph.outgoing[0].label, /outgoing unavailable/);
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  s.model.callsCache.clear(); s.model.language.calls = async item => item.name === 'callee' ? pending : [];
  s.model.language.prepare = async (uri, point) => [s.item(point.line === 20 ? 'new-root' : 'callee', point.line)];
  const old = s.pane.publish();
  await s.model.setRoot({ uri: s.source.uri, range: new s.env.api.Range(20, 4, 20, 8) });
  await s.pane.publish(); resolve([]); await old;
  assert.equal(s.updates.at(-1).graph.root.label, 'new-root');
  s.pane.dispose(); s.model.dispose();
});

test('horizontal graph bounds each side without querying grandchildren', async () => {
  const s = setup('horizontalGraph'); let requests = 0;
  s.model.language.calls = async (root, direction) => {
    requests++; assert.equal(root.name, 'callee');
    return Array.from({ length: 205 }, (_, index) => ({
      [direction === 'incoming' ? 'from' : 'to']: s.item(`node-${index}`, index + 10),
      fromRanges: [new s.env.api.Range(index + 11, 2, index + 11, 8)]
    }));
  };
  await s.model.setRoot(s.source); await s.pane.publish();
  const state = s.updates.at(-1);
  assert.equal(state.graph.incoming.length, 200); assert.equal(state.graph.outgoing.length, 200);
  assert.equal(state.graph.incomingCount, 205); assert.equal(state.truncated, true); assert.equal(requests, 2);
  assert.equal(s.pane.targets.size, 401);
  s.pane.dispose(); s.model.dispose();
});

test('view command saves the chosen mode and configuration updates preserve the locked root', async () => {
  const env = fakeVscode(); env.settings.set('sourceReader.relationView', 'outline');
  const { ReadingController } = loadWithVscode('../src/extension', env.api);
  const controller = new ReadingController(env.context);
  const doc = env.document('view.c'), range = new env.api.Range(0, 4, 0, 9);
  controller.language.prepare = async () => [{ name: 'first', uri: doc.uri, range, selectionRange: range }];
  controller.language.calls = async () => [];
  await controller.relations.setRoot({ uri: doc.uri, range, name: 'first' });
  const root = controller.relations.root; controller.relations.locked = true;
  await env.commands.get('sourceReader.chooseRelationView')();
  assert.equal(env.settings.get('sourceReader.relationView'), 'horizontalGraph');
  env.events.configuration.fire({ affectsConfiguration: key => key === 'sourceReader.relationView' || key === 'sourceReader' });
  await Promise.resolve();
  assert.equal(controller.relations.root, root); assert.equal(controller.relations.locked, true);
  controller.dispose();
});
