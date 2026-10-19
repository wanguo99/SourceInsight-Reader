'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('text search session paginates, wraps navigation, retains independent history and rejects obsolete results', async t => {
  const env = fakeVscode(), cache = new Map(), load = file => loadWithVscode(require.resolve(file), env.api, cache);
  const { TextLookup } = load('../src/text-lookup'), { TextSearchSession } = load('../src/features/search-sessions');
  const { WorkspaceFileCatalog } = load('../src/infrastructure/workspace-file-catalog');
  const doc = env.document('results.c', 'x\n'.repeat(301));
  env.api.workspace.findFiles = async () => [doc.uri]; env.api.workspace.fs.readFile = async () => Buffer.from(doc.getText());
  const catalog = new WorkspaceFileCatalog(), model = new TextLookup(catalog), opened = [], previewed = [];
  const session = new TextSearchSession(model, catalog, row => opened.push(row), row => previewed.push(row));
  t.after(() => { session.dispose(); model.dispose(); catalog.dispose(); });
  await session.launch('x', doc.uri); let state = await session.snapshot(); assert.equal(state.rows.length, 300); assert.equal(state.pages, 2);
  await session.move(-1); assert.equal(opened.at(-1).range.start.line, 300); assert.equal((await session.snapshot()).page, 2);
  await session.move(1); assert.equal(opened.at(-1).range.start.line, 0);
  state = await session.snapshot(); const old = state.rows[0]; await session.handle({ action: 'preview', id: old.id, generation: state.generation }); assert.equal(previewed.length, 1);
  await session.handle({ action: 'search', query: 'missing', folder: 'file:///project' }); assert.equal((await session.snapshot()).rows.length, 0);
  await session.handle({ action: 'open', id: old.id, generation: state.generation }); assert.equal(opened.length, 2);
  const history = (await session.snapshot()).history.find(item => item.query === 'x'); await session.handle({ action: 'history', id: history.id }); assert.equal(model.rows.length, 301);
  doc.text = 'changed'; doc.version++; await session.move(1); assert.equal(model.stale, true); assert.equal(opened.length, 2);
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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/search-results.js'), 'utf8'), {
    document, window: { readerBridge: { postMessage: message => messages.push(message), onMessage: callback => { receive = callback; } } }, acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) })
  });
  receive({ data: { mode: 'text', generation: 1, query: 'target', folder: 'folder', folders: [{ id: 'folder', name: 'project' }], history: [], page: 1, pages: 1, status: '1 处匹配', shortcuts: true,
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
  const env = fakeVscode(); env.settings.set('sourceInsightReader.relationBackend', 'languageService');
  const doc = env.document('route.c', 'int value;\nint read() { return value; }');
  env.api.workspace.findFiles = async () => [doc.uri]; env.api.workspace.fs.readFile = async () => Buffer.from(doc.getText());
  const main = await env.api.window.showTextDocument(doc); main.selection = new env.api.Selection(0, 4, 0, 9);
  const { ReadingController } = loadWithVscode('../src/extension', env.api);
  const controller = new ReadingController(env.context);
  await env.api.commands.executeCommand('sourceInsightReader.lookupText');
  assert.equal(controller.textLookup.query, 'value'); assert.equal(controller.textLookup.rows.length, 2);
  await env.api.commands.executeCommand('sourceInsightReader.nextReference');
  assert.equal(env.api.window.activeTextEditor.selection.start.line, 0);
  await env.api.commands.executeCommand('sourceInsightReader.nextReference');
  assert.equal(env.api.window.activeTextEditor.selection.start.line, 1);
  assert.equal(env.api.window.activeTextEditor.selection.start.character, 20);
  let semantic = 0; controller.referenceSession.move = async () => { semantic++; };
  controller.searchResultsView.show('references'); await env.api.commands.executeCommand('sourceInsightReader.nextReference');
  assert.equal(semantic, 1);
  controller.searchResultsView.show('text'); await env.api.commands.executeCommand('sourceInsightReader.previousReference');
  assert.equal(env.api.window.activeTextEditor.selection.start.line, 0);
  controller.dispose();
});
