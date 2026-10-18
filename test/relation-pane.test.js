'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function setup() {
  const env = fakeVscode();
  const { RelationTree } = loadWithVscode('../src/trees', env.api);
  const { RelationPane } = loadWithVscode('../src/relation-pane', env.api);
  const doc = env.document('calls.c');
  const item = (name, line) => ({ name, uri: doc.uri, kind: 11,
    range: new env.api.Range(line, 0, line + 1, 0), selectionRange: new env.api.Range(line, 4, line, 8) });
  const callee = item('callee', 0), caller = item('caller', 3);
  let calls = 0;
  const model = new RelationTree({ prepare: async () => [callee], calls: async root => {
    calls++;
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
