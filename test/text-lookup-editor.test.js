'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function panels(env) {
  const result = [];
  env.api.window.createWebviewPanel = (type, title, column, options) => {
    const disposed = new env.api.EventEmitter(), messages = new env.api.EventEmitter(), active = new env.api.EventEmitter();
    const panel = { type, title, column, options, updates: [], reveal() {}, onDidDispose: disposed.event, onDidChangeViewState: active.event,
      dispose() { disposed.fire(); }, webview: { cspSource: 'test:', asWebviewUri: uri => uri, onDidReceiveMessage: messages.event,
        async postMessage(state) { panel.updates.push(state); } } };
    result.push(panel); return panel;
  };
  return result;
}

test('text lookup results paginate, open exact matches, wrap navigation and retain independent query history', async () => {
  const env = fakeVscode(), list = panels(env), opened = [], previewed = [], errors = [];
  const { TextLookup } = loadWithVscode('../src/text-lookup', env.api);
  const { TextLookupEditor } = loadWithVscode('../src/text-lookup-editor', env.api);
  const doc = env.document('results.c', 'x\n'.repeat(301));
  env.api.workspace.findFiles = async () => [doc.uri]; env.api.workspace.fs.readFile = async () => Buffer.from(doc.getText());
  const model = new TextLookup();
  const editor = new TextLookupEditor(env.context, model, row => opened.push(row), row => previewed.push(row), () => {}, error => errors.push(error));
  await editor.launch('x', doc.uri);
  const panel = list[0]; assert.equal(panel.type, 'sourceInsightInspired.textLookup');
  assert.match(panel.webview.html, /所在函数/); assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.equal(panel.updates.at(-1).rows.length, 300); assert.equal(panel.updates.at(-1).pages, 2);
  await editor.move(-1); assert.equal(opened.at(-1).range.start.line, 300); assert.equal(panel.updates.at(-1).page, 2);
  await editor.move(1); assert.equal(opened.at(-1).range.start.line, 0); assert.equal(panel.updates.at(-1).page, 1);
  assert.equal(previewed.at(-1).mode, '字符匹配');
  const old = panel.updates.at(-1).rows[0].id;
  await editor.handle({ action: 'preview', id: old }); assert.equal(opened.length, 2);
  await editor.handle({ action: 'search', query: 'missing', folder: 'file:///project' });
  assert.equal(panel.updates.at(-1).rows.length, 0);
  await editor.handle({ action: 'open', id: old }); assert.equal(opened.length, 2);
  const history = panel.updates.at(-1).history.find(item => item.query === 'x');
  await editor.handle({ action: 'history', id: history.id }); assert.equal(model.rows.length, 301);
  doc.text = 'changed'; doc.version++; await editor.move(1); assert.equal(model.stale, true); assert.equal(opened.length, 2);
  assert.equal(errors.length, 0); editor.dispose(); model.dispose();
});

test('text lookup renderer keeps snippets literal, highlights only the match and routes search/F8/navigation', () => {
  const elements = new Map(), messages = []; let receive, keydown;
  const document = { activeElement: undefined, getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id);
  }, createElement: () => new Element(), addEventListener(name, handler) { keydown = handler; } };
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.value = ''; this.className = ''; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(name, value) { this[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelector() { return null; }
    focus() { document.activeElement = this; }
    select() {}
    set innerHTML(value) { throw new Error('HTML injection'); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/text-lookup.js'), 'utf8'), {
    document, window: { addEventListener(name, handler) { receive = handler; } }, acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) })
  });
  receive({ data: { session: 1, query: 'target', folder: 'folder', folders: [{ id: 'folder', name: 'project' }], history: [], page: 1, pages: 1, status: '1 处匹配', shortcuts: true,
    rows: [{ id: '1', owner: 'main', path: 'a.c', line: 2, column: 3, before: '<script>', matched: 'target', after: '</script>' }] } });
  const row = elements.get('results').children[0], button = row.children[2].children[0];
  assert.equal(button.children[0].textContent, '<script>'); assert.equal(button.children[1].textContent, 'target');
  button.handlers.click({ altKey: false }); assert.equal(messages.at(-1).action, 'open');
  button.handlers.click({ altKey: true }); assert.equal(messages.at(-1).action, 'preview');
  keydown({ key: 'F8', shiftKey: true, preventDefault() {} }); assert.equal(messages.at(-1).action, 'previous');
  const query = elements.get('query'); query.value = 'new'; query.focus();
  keydown({ key: 'Enter', preventDefault() {} }); assert.equal(messages.at(-1).query, 'new'); assert.equal(messages.at(-1).folder, 'folder');
});

test('editor commands search the selected text and F8 follows the active lookup without breaking semantic references', async () => {
  const env = fakeVscode(); panels(env); env.settings.set('sourceInsightInspired.relationBackend', 'languageService');
  const doc = env.document('route.c', 'int value;\nint read() { return value; }');
  env.api.workspace.findFiles = async () => [doc.uri]; env.api.workspace.fs.readFile = async () => Buffer.from(doc.getText());
  const main = await env.api.window.showTextDocument(doc); main.selection = new env.api.Selection(0, 4, 0, 9);
  const { ReadingController } = loadWithVscode('../src/extension', env.api);
  const controller = new ReadingController(env.context);
  await env.api.commands.executeCommand('sourceInsightInspired.lookupText');
  assert.equal(controller.textLookup.query, 'value'); assert.equal(controller.textLookup.rows.length, 2);
  await env.api.commands.executeCommand('sourceInsightInspired.nextReference');
  assert.equal(env.api.window.activeTextEditor.selection.start.line, 0);
  await env.api.commands.executeCommand('sourceInsightInspired.nextReference');
  assert.equal(env.api.window.activeTextEditor.selection.start.line, 1);
  assert.equal(env.api.window.activeTextEditor.selection.start.character, 20);
  let semantic = 0; controller.moveReference = async () => { semantic++; };
  controller.referencesView.show(); await env.api.commands.executeCommand('sourceInsightInspired.nextReference');
  assert.equal(semantic, 1);
  controller.textLookupView.show(); await env.api.commands.executeCommand('sourceInsightInspired.previousReference');
  assert.equal(env.api.window.activeTextEditor.selection.start.line, 0);
  controller.dispose();
});
