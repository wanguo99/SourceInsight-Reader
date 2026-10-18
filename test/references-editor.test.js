'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('reference editor opens in editor area, filters, navigates exact locations, rejects stale rows and recreates on close', async () => {
  const env = fakeVscode(), panels = [];
  env.api.ViewColumn.Active = -1;
  env.api.window.createWebviewPanel = (type, title, column, options) => {
    const disposed = new env.api.EventEmitter(), messages = new env.api.EventEmitter();
    const panel = { type, title, column, options, updates: [], reveal() { this.revealed = true; },
      onDidDispose: disposed.event, dispose() { disposed.fire(); },
      webview: { cspSource: 'vscode-resource:', asWebviewUri: uri => uri.toString(), onDidReceiveMessage: messages.event,
        async postMessage(state) { panel.updates.push(state); } } };
    panels.push(panel); return panel;
  };
  const { ReferencesTree } = loadWithVscode('../src/trees', env.api);
  const { ReferencesEditor } = loadWithVscode('../src/references-editor', env.api);
  const doc = env.document('ref.c', 'int value;\nint read() { return value; }\n');
  const range = new env.api.Range(1, 20, 1, 25);
  const model = new ReferencesTree({ references: async () => [{ uri: doc.uri, range }] });
  const opened = [], previewed = [], failures = [];
  const editor = new ReferencesEditor(env.context.extensionUri, model, node => opened.push(node), node => previewed.push(node), e => failures.push(e));
  const source = { uri: doc.uri, range: new env.api.Range(0, 4, 0, 9), name: 'value' };
  editor.show(); await model.lookup(source); await editor.publish();
  const panel = panels[0], row = panel.updates.at(-1).groups[0].rows[0];
  assert.equal(panel.column, -1); assert.equal(panel.options.enableScripts, true);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  await editor.handle({ action: 'open', id: row.id });
  assert.equal(opened[0].range, range);
  await editor.handle({ action: 'preview', id: row.id }); assert.equal(previewed.length, 1);
  await editor.handle({ action: 'filter', query: 'missing' }); await editor.publish();
  assert.equal(panel.updates.at(-1).groups.length, 0);
  await editor.handle({ action: 'open', id: row.id }); assert.equal(opened.length, 1);
  await editor.handle({ action: 'filter', query: 'return value' }); await editor.publish();
  assert.equal(panel.updates.at(-1).groups[0].rows[0].snippet, 'int read() { return value; }');
  model.markStale(); await editor.publish(); assert.match(panel.updates.at(-1).status, /请刷新/);
  panel.dispose(); editor.show(); await editor.publish(); assert.equal(panels.length, 2);
  assert.equal(panels[1].updates.at(-1).groups.length, 1);
  await editor.handle({ action: 'clear' }); await editor.publish(); assert.equal(panels[1].updates.at(-1).groups.length, 0);
  assert.equal(failures.length, 0); editor.dispose(); model.dispose();
});
