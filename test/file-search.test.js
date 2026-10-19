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
  const { WorkspaceFileCatalog } = loadWithVscode('../src/infrastructure/workspace-file-catalog', env.api);
  const catalog = new WorkspaceFileCatalog();
  const module = loadWithVscode('../src/file-search', env.api);
  const view = new module.FileSearchView(env.context, catalog, async file => opened.push(file), error => errors.push(error));
  const messages = new env.api.EventEmitter(), visibility = new env.api.EventEmitter();
  const native = { visible: true, onDidChangeVisibility: visibility.event, onDidDispose: new env.api.EventEmitter().event, webview: {
    cspSource: 'test:', asWebviewUri: uri => uri, onDidReceiveMessage: messages.event,
    async postMessage(state) { updates.push(state.payload); }
  } };
  require('./view-fixture').connectActions(messages, native.webview);
  return { env, updates, opened, errors, view, native, ...module };
}

test('file filtering uses name substrings, retains only matching directories and ancestor chains', () => {
  const s = setup();
  const paths = ['src/main.c', 'src/domain.c', 'src/m_a_i_n.c', 'maintain/unrelated.c', 'maintain/sub/main_test.c', 'other/unused.c', '目录/设备目录.c'];
  const tree = s.fileTree(paths.map(value => ({ uri: s.env.api.Uri.file('/project/' + value), path: value, name: value.split('/').pop() })));
  const flatten = nodes => nodes.flatMap(node => [node.name, ...flatten(node.children)]);
  const matches = s.filterFileTree(tree, 'MAIN');
  assert.equal(matches.files, 3); assert.equal(matches.directories, 1);
  assert.deepEqual(flatten(matches.roots), ['工程', 'maintain', 'sub', 'main_test.c', 'src', 'domain.c', 'main.c']);
  assert.deepEqual(flatten(s.filterFileTree(tree, 'src\\main').roots), ['工程', 'src', 'main.c']);
  assert.deepEqual(flatten(s.filterFileTree(tree, 'src main').roots), ['工程', 'src', 'domain.c', 'main.c']);
  assert.deepEqual(flatten(s.filterFileTree(tree, '目录 设备').roots), ['工程', '目录', '设备目录.c']);
  assert.equal(s.filterFileTree(tree, 'm_a_i').files, 1);
  assert.equal(s.filterFileTree(tree, 'missing').roots.length, 0);
  const capped = s.filterFileTree(tree, 'main', 1);
  assert.equal(capped.total, 4); assert.equal(flatten(capped.roots).includes('unrelated.c'), false);
  assert.equal(flatten(capped.roots).length, 2); s.view.dispose();
});

test('project file tree filters in place, opens exact matches, persists query and rejects obsolete IDs', async () => {
  const s = setup(), commands = [];
  const uris = ['src/bmc/catalog.c', 'node_modules/catalog.c', 'src/other.c'].map(file => s.env.api.Uri.file(`/project/${file}`));
  s.env.api.workspace.findFiles = async () => uris;
  s.env.api.commands.executeCommand = async (name, uri) => commands.push({ name, uri });
  s.view.resolveWebviewView(s.native); await s.view.refresh();
  assert.match(s.native.webview.html, /id="query"/);
  assert.doesNotMatch(s.native.webview.html, /placeholder=|id="status"|id="clear"|id="refresh"/);
  await s.view.handleMessage({ action: 'search', query: 'src catalog' });
  assert.deepEqual(s.updates.at(-1).rows.map(row => row.name), ['project', 'src', 'bmc', 'catalog.c']);
  const row = s.updates.at(-1).rows.at(-1);
  assert.equal(row.type, 'file');
  await s.view.handleMessage({ action: 'open', id: row.id });
  assert.equal(s.opened[0].uri.toString(), uris[0].toString());
  assert.equal(commands.length, 0); // independent of the native Explorer
  assert.equal(s.updates.at(-1).rows.at(-1).selected, true);
  assert.equal(s.env.context.workspaceState.get('fileSearch.query'), 'src catalog');
  await s.view.handleMessage({ action: 'search', query: 'other' });
  await s.view.handleMessage({ action: 'open', id: row.id }); assert.equal(s.opened.length, 1);
  assert.equal(s.view.files.length, 2); assert.equal(s.errors.length, 0); s.view.dispose();
});

test('newer file scan wins over delayed results and scan failures retain usable matches', async () => {
  const s = setup(); s.view.resolveWebviewView(s.native); await new Promise(resolve => setImmediate(resolve));
  let finish;
  s.env.api.workspace.findFiles = () => new Promise(resolve => { finish = resolve; });
  const first = s.view.refresh(); await new Promise(resolve => setImmediate(resolve));
  s.env.api.workspace.findFiles = async () => [s.env.api.Uri.file('/project/new.c')];
  await s.view.refresh(); finish([s.env.api.Uri.file('/project/old.c')]); await first;
  await s.view.handleMessage({ action: 'search', query: 'new' });
  assert.equal(s.updates.at(-1).rows.at(-1).name, 'new.c');
  s.env.api.workspace.findFiles = async () => { throw new Error('scan failed'); };
  await s.view.refresh();
  assert.equal(s.updates.at(-1).rows.at(-1).name, 'new.c'); assert.match(s.updates.at(-1).status, /扫描失败/);
  s.view.dispose();
});

test('file search renderer preserves text, handles live query and uses safe icons when fonts or images fail', async () => {
  let receive; const messages = [], elements = new Map();
  const document = { activeElement: null, createElement: () => new Element(), getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id);
  } };
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.value = ''; this.style = {}; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(name, value) { this[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    focus() { document.activeElement = this; }
    querySelector() { return null; }
    set innerHTML(value) { throw new Error('HTML injection'); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/file-search.js'), 'utf8'), {
    document, window: { readerBridge: { postMessage: message => messages.push(message), onMessage: callback => { receive = callback; } } },
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) })
  });
  receive({ data: { query: '', status: '1 个匹配', rows: [{ id: 'file-1', key: 'key-1', type: 'file', depth: 1, name: '<script>.c', path: '目录/<script>.c', tooltip: '/目录/<script>.c' }] } });
  const button = elements.get('results').children[0].children[0];
  assert.equal(button.children[3].textContent, '<script>.c');
  button.handlers.click(); assert.equal(messages.at(-1).id, 'file-1');
  const query = elements.get('query'); query.focus(); query.value = 'src catalog'; query.handlers.input();
  assert.equal(messages.at(-1).query, 'src catalog');
  query.handlers.compositionstart(); query.value = '目录'; const count = messages.length; query.handlers.input();
  assert.equal(messages.length, count); query.handlers.compositionend(); assert.equal(messages.at(-1).query, '目录');
  query.handlers.keydown({ key: 'Escape' }); assert.equal(messages.at(-1).query, '');
  receive({ data: { query: '', status: '扫描状态', rows: [] } });
  assert.equal(query.title, '扫描状态');
  assert.equal(elements.has('status'), false);
  assert.equal(elements.has('clear'), false);
  assert.equal(elements.has('refresh'), false);
  const data = { query: '', status: '', iconCss: 'font-v1', rows: [
    { id: 'font-file', key: 'key-font', type: 'file', depth: 1, name: 'test.c', icon: { glyph: '\ue001', family: 'si-files-icon-0', size: '100%' } }
  ] };
  const currentIcon = () => elements.get('results').children[0].children[0].children[2];
  document.fonts = { load: async () => [] };
  receive({ data });
  assert.match(currentIcon().className, /generic-file/); assert.equal(currentIcon().textContent, '');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(currentIcon().className, /generic-file/);
  let loaded = 0;
  document.fonts.load = async () => { loaded++; return [{}]; };
  data.iconCss = 'font-v2'; receive({ data }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(currentIcon().textContent, '\ue001'); assert.doesNotMatch(currentIcon().className, /generic-file/);
  receive({ data }); await new Promise(resolve => setImmediate(resolve)); assert.equal(loaded, 1);
  document.fonts.load = async () => { throw new Error('font missing'); };
  data.iconCss = 'font-v3'; receive({ data }); await new Promise(resolve => setImmediate(resolve));
  assert.match(currentIcon().className, /generic-file/); assert.equal(currentIcon().textContent, '');
  data.rows[0].icon = { uri: 'missing.svg' }; receive({ data });
  currentIcon().children[0].handlers.error();
  assert.match(currentIcon().className, /generic-file/); assert.equal(currentIcon().children.length, 0);
});

 test('directory expansion is independent of search and filtering keeps matching files under their parents', async () => {
  const s = setup();
  s.env.api.workspace.findFiles = async () => ['src/bmc/catalog.c', 'src/bmc/decode.c', 'include/types.h'].map(file => s.env.api.Uri.file(`/project/${file}`));
  s.view.resolveWebviewView(s.native); await s.view.refresh();
  assert.deepEqual(s.updates.at(-1).rows.map(row => row.name), ['project', 'include', 'src']);
  const src = s.updates.at(-1).rows.find(row => row.name === 'src');
  await s.view.handleMessage({ action: 'toggle', id: src.id });
  assert(s.updates.at(-1).rows.some(row => row.name === 'bmc'));
  await s.view.handleMessage({ action: 'search', query: 'bmc catalog' });
  assert.deepEqual(s.updates.at(-1).rows.map(row => row.name), ['project', 'src', 'bmc', 'catalog.c']);
  await s.view.handleMessage({ action: 'search', query: '' });
  assert.deepEqual(s.updates.at(-1).rows.map(row => row.name), ['project', 'include', 'src', 'bmc']);
  await s.view.revealFile(s.env.api.Uri.file('/project/include/types.h'));
  assert(s.updates.at(-1).rows.some(row => row.name === 'types.h' && row.selected));
  assert.equal(s.env.context.workspaceState.get('files.expansion').length, 1);
  s.view.dispose();
});
 test('file tree keeps workspace roots and directories distinct for same-named files', () => {
  const s = setup();
  const files = ['one', 'two'].map(root => ({ uri: s.env.api.Uri.file(`/${root}/lib/name.c`), name: 'name.c', path: `${root}/lib/name.c`, relative: 'lib/name.c', rootName: root, rootKey: root, rootPath: `/${root}` }));
  const tree = s.fileTree(files);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].children[0].name, 'lib');
  assert.notEqual(tree[0].children[0].children[0].key, tree[1].children[0].children[0].key);
  s.view.dispose();
});
