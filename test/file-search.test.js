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
  assert.ok(s.native.webview.html.indexOf('id="manage-directories"') < s.native.webview.html.indexOf('id="query"'));
  await s.view.handleMessage({ action: 'manageDirectories' });
  assert.equal(commands.at(-1).name, 'sourceInsightReader.manageReadingDirectories');
  assert.equal(s.updates.at(-1).excludedCount, 0);
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
  assert.equal(JSON.parse(button['data-vscode-context']).webviewSection, 'entry');
  receive({ data: { query: '', rows: [{ id: 'dir-1', key: 'dir-key', type: 'directory', name: 'src', depth: 0 }] } });
  assert.deepEqual(JSON.parse(elements.get('results').children[0].children[0]['data-vscode-context']),
    { webviewSection: 'entry', targetId: 'dir-1', preventDefaultContextMenuItems: true });
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

test('context menu excludes current directories and files and rejects obsolete targets', async () => {
  const s = setup();
  s.env.api.workspace.findFiles = async () => ['src/build/a.c', 'src/build2/b.c'].map(file => s.env.api.Uri.file('/project/' + file));
  s.view.resolveWebviewView(s.native); await s.view.refresh();
  await s.view.handleMessage({ action: 'search', query: 'build' });
  const rows = s.updates.at(-1).rows;
  const directory = rows.find(row => row.name === 'build');
  assert.ok(directory);
  await s.view.excludeDirectory({ targetId: directory.id });
  assert.deepEqual(s.env.settings.get('sourceInsightReader.excludedDirectories'), ['src/build']);
  assert.equal(s.view.catalog.contains(s.env.api.Uri.file('/project/src/build2/b.c')), true);
  await s.view.excludeDirectory({ targetId: directory.id });
  assert.deepEqual(s.env.settings.get('sourceInsightReader.excludedDirectories'), ['src/build']);
  await s.view.handleMessage({ action: 'search', query: 'build2 b.c' });
  const file = s.updates.at(-1).rows.find(row => row.type === 'file');
  await s.view.excludeDirectory({ targetId: file.id });
  await s.view.excludeDirectory({ targetId: directory.id });
  await s.view.excludeDirectory({ targetId: 'invalid', uri: '/project/src' });
  assert.deepEqual(s.env.settings.get('sourceInsightReader.excludedDirectories'), ['src/build']);
  assert.deepEqual(s.env.settings.get('sourceInsightReader.excludedFiles'), ['src/build2/b.c']);
  assert.equal(s.opened.length, 0);
  s.view.dispose();
});

test('directory context menu keeps same-named folders in peer workspace roots distinct', async () => {
  const s = setup();
  s.env.api.workspace.workspaceFolders.push({ uri: s.env.api.Uri.file('/other'), name: 'other', index: 1 });
  s.env.api.workspace.findFiles = async () => ['/project/src/a.c', '/other/src/a.c'].map(file => s.env.api.Uri.file(file));
  s.view.resolveWebviewView(s.native); await s.view.refresh();
  await s.view.handleMessage({ action: 'search', query: 'src' });
  const rows = s.updates.at(-1).rows;
  const directory = rows.find(row => row.name === 'src' && row.tooltip === '/other/src');
  await s.view.excludeDirectory({ targetId: directory.id });
  assert.deepEqual(s.env.settings.get('sourceInsightReader.excludedDirectories'), [s.env.api.Uri.file('/other/src').toString()]);
  assert.equal(s.view.catalog.contains(s.env.api.Uri.file('/project/src/a.c')), true);
  assert.equal(s.view.catalog.contains(s.env.api.Uri.file('/other/src/a.c')), false);
  s.view.dispose();
});

test('batch blocking writes selected files together, keeps neighboring files and rejects stale batches', async () => {
  const s = setup();
  s.env.api.workspace.findFiles = async () => ['src/a.c', 'src/b.c', 'src/c.c'].map(file => s.env.api.Uri.file('/project/' + file));
  s.view.resolveWebviewView(s.native); await s.view.refresh();
  await s.view.handleMessage({ action: 'search', query: 'src .c' });
  const rows = s.updates.at(-1).rows.filter(row => row.type === 'file');
  await s.view.excludeDirectory({ targetId: rows[0].id, targetIds: JSON.stringify([rows[0].id, 'stale']) });
  assert.equal(s.env.settings.get('sourceInsightReader.excludedFiles'), undefined);
  await s.view.excludeDirectory({ targetId: rows[0].id, targetIds: JSON.stringify(rows.slice(0, 2).map(row => row.id)) });
  assert.deepEqual(s.env.settings.get('sourceInsightReader.excludedFiles'), ['src/a.c', 'src/b.c']);
  assert.equal(s.view.catalog.contains(s.env.api.Uri.file('/project/src/c.c')), true);
  s.view.dispose();
});

test('Shift range and Ctrl additive selection feed native context menu without opening files', () => {
  let receive;
  const messages = [], elements = new Map();
  const document = { activeElement: null, createElement: () => new Element(), getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id);
  } };
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.style = {}; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(name, value) { this[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    focus() { document.activeElement = this; }
    querySelector() { return null; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/file-search.js'), 'utf8'), {
    document, window: { readerBridge: { postMessage: value => messages.push(value), onMessage: callback => { receive = callback; } } }
  });
  const rows = ['a.c', 'b.c', 'c.c', 'd.c'].map((name, i) => ({ id: String(i), key: name, type: 'file', name, depth: 0 }));
  receive({ data: { query: '', rows, excludedCount: 2 } });
  const buttons = () => elements.get('results').children[0].children;
  buttons()[0].handlers.click();
  const before = messages.length;
  buttons()[2].handlers.click({ shiftKey: true });
  assert.equal(messages.length, before);
  assert.deepEqual(buttons().map(button => button['aria-selected']), ['true', 'true', 'true', 'false']);
  buttons()[3].handlers.click({ ctrlKey: true });
  buttons()[1].handlers.contextmenu();
  assert.deepEqual(JSON.parse(JSON.parse(buttons()[1]['data-vscode-context']).targetIds), ['0', '1', '2', '3']);
  assert.equal(elements.get('manage-directories').textContent, '已屏蔽（2）');
  assert.equal(elements.has('scope-summary'), false);
  receive({ data: { query: '', rows: rows.map(row => ({ ...row, id: 'new-' + row.id })) } });
  buttons()[1].handlers.contextmenu();
  assert.deepEqual(JSON.parse(JSON.parse(buttons()[1]['data-vscode-context']).targetIds), ['new-0', 'new-1', 'new-2', 'new-3']);
  buttons()[0].handlers.click({ ctrlKey: true });
  buttons()[0].handlers.contextmenu();
  assert.deepEqual(JSON.parse(JSON.parse(buttons()[0]['data-vscode-context']).targetIds), ['new-0']);
});

test('adding exclusions prunes the visible tree immediately without rescanning or empty intermediate states', async () => {
  const s = setup(); let scans = 0;
  s.env.api.workspace.findFiles = async () => { scans++; return ['src/a.c', 'src/b.c'].map(file => s.env.api.Uri.file('/project/' + file)); };
  s.view.resolveWebviewView(s.native); await s.view.refresh();
  await s.view.handleMessage({ action: 'search', query: 'src .c' });
  const before = scans, start = s.updates.length;
  const kept = s.updates.at(-1).rows.find(row => row.name === 'b.c');
  s.env.settings.set('sourceInsightReader.excludedFiles', ['src/a.c']);
  s.env.events.configuration.fire({ affectsConfiguration: key => key === 'sourceInsightReader.excludedFiles' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.view.dirty, false);
  assert.equal(scans, before);
  assert.ok(s.updates.slice(start).every(state => state.rows.some(row => row.key === kept.key)));
  assert.equal(s.updates.at(-1).rows.some(row => row.name === 'a.c'), false);
  assert.equal(s.updates.at(-1).excludedCount, 1);
  const row = s.updates.at(-1).rows.find(row => row.name === 'b.c');
  await s.view.handleMessage({ action: 'open', id: row.id });
  assert.equal(s.opened.at(-1).uri.path, '/project/src/b.c');
  s.view.dispose();
});

test('unblocking retains usable rows while background enumeration runs and failure does not blank the tree', async () => {
  const s = setup();
  const uris = ['src/a.c', 'src/b.c'].map(file => s.env.api.Uri.file('/project/' + file));
  s.env.settings.set('sourceInsightReader.excludedFiles', ['src/a.c']);
  s.env.api.workspace.findFiles = async () => uris.slice(1);
  s.view.resolveWebviewView(s.native); await s.view.refresh();
  await s.view.handleMessage({ action: 'search', query: 'src .c' });
  const start = s.updates.length;
  s.env.settings.set('sourceInsightReader.excludedFiles', []);
  s.env.events.configuration.fire({ affectsConfiguration: key => key === 'sourceInsightReader.excludedFiles' });
  clearTimeout(s.view.timer);
  let finish;
  s.env.api.workspace.findFiles = () => new Promise(resolve => { finish = resolve; });
  const background = s.view.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(s.updates.slice(start).every(state => state.rows.some(row => row.name === 'b.c')));
  finish(uris); await background;
  assert.ok(s.updates.at(-1).rows.some(row => row.name === 'a.c'));
  assert.equal(s.updates.at(-1).reveal, false);
  s.env.api.workspace.findFiles = async () => { throw new Error('unavailable'); };
  await s.view.refresh();
  assert.ok(s.updates.at(-1).rows.some(row => row.name === 'b.c'));
  s.view.dispose();
});

test('blocking during an old scan cancels it and late results cannot reintroduce excluded files', async () => {
  const s = setup();
  const uris = ['src/a.c', 'src/b.c'].map(file => s.env.api.Uri.file('/project/' + file));
  s.env.api.workspace.findFiles = async () => uris;
  s.view.resolveWebviewView(s.native); await s.view.refresh();
  await s.view.handleMessage({ action: 'search', query: 'src .c' });
  let finish, token;
  s.env.api.workspace.findFiles = (pattern, exclude, limit, cancellation) => { token = cancellation; return new Promise(resolve => { finish = resolve; }); };
  const old = s.view.refresh(); await new Promise(resolve => setImmediate(resolve));
  s.env.settings.set('sourceInsightReader.excludedFiles', ['src/a.c']);
  s.env.events.configuration.fire({ affectsConfiguration: key => key === 'sourceInsightReader.excludedFiles' });
  assert.equal(token.isCancellationRequested, true);
  finish(uris); await old;
  assert.equal(s.updates.at(-1).rows.some(row => row.name === 'a.c'), false);
  assert.ok(s.updates.at(-1).rows.some(row => row.name === 'b.c'));
  s.view.dispose();
});
