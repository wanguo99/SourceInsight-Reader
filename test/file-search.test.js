'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function setup() {
  const env = fakeVscode(), updates = [], opened = [], errors = [];
  const saved = new Map();
  env.context.workspaceState = { get(key, fallback) { return saved.has(key) ? saved.get(key) : fallback; }, async update(key, value) { saved.set(key, value); } };
  const module = loadWithVscode('../src/file-search', env.api);
  const view = new module.FileSearchView(env.context, async file => opened.push(file), error => errors.push(error));
  const messages = new env.api.EventEmitter(), visibility = new env.api.EventEmitter();
  const native = { visible: true, onDidChangeVisibility: visibility.event, webview: {
    cspSource: 'test:', asWebviewUri: uri => uri, onDidReceiveMessage: messages.event,
    async postMessage(state) { updates.push(state); }
  } };
  return { env, updates, opened, errors, view, native, ...module };
}

test('file matching supports fuzzy path and filename tokens, Windows separators, Unicode and filename priority', () => {
  const s = setup(), { rankFiles } = s;
  const rows = ['src/bmc/device_catalog.c', 'src/other/device_catalog.c', 'src/bmc/readme.h', '目录/设备目录.c', 'main-folder/other.c', 'main.c']
    .map(value => ({ path: value, name: value.split('/').pop() }));
  assert.deepEqual(rankFiles(rows, 'SRC\\BMC catlg').rows.map(row => row.path), ['src/bmc/device_catalog.c']);
  assert.equal(rankFiles(rows, '目录 设备').rows[0].name, '设备目录.c');
  assert.equal(rankFiles(rows, 'main').rows[0].name, 'main.c');
  assert.equal(rankFiles(rows, 'missing-file-name').total, 0);
  assert.equal(rankFiles(rows, '').total, 0);
  assert.equal(rankFiles(rows, 'catalog', 1).rows.length, 1);
  assert.equal(rankFiles(rows, 'catalog', 1).total, 2); s.view.dispose();
});

test('Explorer search respects exclusion rules, opens and reveals exact matches, persists query and rejects obsolete IDs', async () => {
  const s = setup(), commands = [];
  const uris = ['src/bmc/catalog.c', 'node_modules/catalog.c', 'src/other.c'].map(file => s.env.api.Uri.file(`/project/${file}`));
  s.env.api.workspace.findFiles = async () => uris;
  s.env.api.commands.executeCommand = async (name, uri) => commands.push({ name, uri });
  s.view.resolveWebviewView(s.native); await s.view.refresh();
  assert.match(s.native.webview.html, /id="query"/);
  await s.view.handleMessage({ action: 'search', query: 'src catlg' });
  assert.equal(s.updates.at(-1).rows.length, 1);
  const row = s.updates.at(-1).rows[0];
  assert.equal(row.path, 'src/bmc/catalog.c');
  await s.view.handleMessage({ action: 'open', id: row.id });
  assert.equal(s.opened[0].uri.toString(), uris[0].toString());
  assert.equal(commands[0].name, 'revealInExplorer'); assert.equal(commands[0].uri, uris[0]);
  assert.equal(commands[1].name, 'workbench.action.focusActiveEditorGroup');
  assert.equal(s.env.context.workspaceState.get('fileSearch.query'), 'src catlg');
  await s.view.handleMessage({ action: 'search', query: 'other' });
  await s.view.handleMessage({ action: 'open', id: row.id }); assert.equal(s.opened.length, 1);
  assert.equal(s.view.files.length, 2); assert.equal(s.errors.length, 0); s.view.dispose();
});

test('newer file scan wins over delayed results and scan failures retain usable matches', async () => {
  const s = setup(); s.view.view = s.native;
  let finish;
  s.env.api.workspace.findFiles = () => new Promise(resolve => { finish = resolve; });
  const first = s.view.refresh(); await new Promise(resolve => setImmediate(resolve));
  s.env.api.workspace.findFiles = async () => [s.env.api.Uri.file('/project/new.c')];
  await s.view.refresh(); finish([s.env.api.Uri.file('/project/old.c')]); await first;
  await s.view.handleMessage({ action: 'search', query: 'new' });
  assert.equal(s.updates.at(-1).rows[0].name, 'new.c');
  s.env.api.workspace.findFiles = async () => { throw new Error('scan failed'); };
  await s.view.refresh();
  assert.equal(s.updates.at(-1).rows[0].name, 'new.c'); assert.match(s.updates.at(-1).status, /扫描失败/);
  s.view.dispose();
});

test('file search renderer uses literal text and supports live query, IME, clear and exact result messages', () => {
  let receive; const messages = [], elements = new Map();
  const document = { activeElement: null, createElement: () => new Element(), getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id);
  } };
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.value = ''; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    focus() { document.activeElement = this; }
    querySelector() { return null; }
    set innerHTML(value) { throw new Error('HTML injection'); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/file-search.js'), 'utf8'), {
    document, window: { addEventListener(name, handler) { receive = handler; } },
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) })
  });
  receive({ data: { query: '', status: '1 个匹配', rows: [{ id: 'file-1', name: '<script>.c', path: '目录/<script>.c', tooltip: '/目录/<script>.c' }] } });
  const button = elements.get('results').children[0].children[0];
  assert.equal(button.children[0].textContent, '<script>.c');
  button.handlers.click(); assert.equal(messages.at(-1).id, 'file-1');
  const query = elements.get('query'); query.focus(); query.value = 'src catlg'; query.handlers.input();
  assert.equal(messages.at(-1).query, 'src catlg');
  query.handlers.compositionstart(); query.value = '目录'; const count = messages.length; query.handlers.input();
  assert.equal(messages.length, count); query.handlers.compositionend(); assert.equal(messages.at(-1).query, '目录');
  elements.get('clear').handlers.click(); assert.equal(messages.at(-1).query, '');
  elements.get('refresh').handlers.click(); assert.equal(messages.at(-1).action, 'refresh');
});
