'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('bottom Search Results hosts both modes, resolves local assets, routes messages and preserves inactive results', async () => {
  const env = fakeVscode(), commands = [], errors = [];
  const { SearchResultsView } = loadWithVscode('../src/search-results-view', env.api);
  env.api.commands.executeCommand = async command => commands.push(command);
  const host = new SearchResultsView(env.context.extensionUri, error => errors.push(error));
  const text = host.createPanel('text'), references = host.createPanel('references');
  const events = new env.api.EventEmitter(), disposed = new env.api.EventEmitter(), sent = [], received = [];
  const view = { show() {}, onDidDispose: disposed.event, webview: { cspSource: 'test:',
    asWebviewUri: uri => `asset:${uri.path}`, onDidReceiveMessage: events.event,
    async postMessage(value) { sent.push(value); return true; } } };
  host.resolveWebviewView(view);
  text.webview.onDidReceiveMessage(value => received.push(value));
  host.show('text');
  text.webview.html = '<body><script nonce="safe" src="asset:renderer.js"></script></body>';
  assert.match(view.webview.html, /lookupTextTab/);
  assert.match(view.webview.html, /asset:.*search-results.js/);
  assert.match(view.webview.html, /nonce="safe"/);
  events.fire({ action: 'ready' }); assert.equal(received[0].action, 'ready');
  await text.webview.postMessage({ rows: [1] }); assert.equal(sent.length, 1);
  events.fire({ action: 'switchResults', mode: 'references' });
  assert.equal(commands.at(-1), 'sourceInsightInspired.focusReferences');
  host.show('references'); references.webview.html = '<body>References<script nonce="safe"></script></body>';
  await text.webview.postMessage({ rows: [2] }); assert.equal(sent.length, 1);
  await references.webview.postMessage({ groups: [] }); assert.equal(sent.length, 2);
  host.show('text'); assert.match(view.webview.html, /renderer.js/);
  disposed.fire(); assert.equal(host.view, undefined);
  assert.equal(errors.length, 0); host.dispose();
});
