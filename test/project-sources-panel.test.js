'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

async function fixture(t) {
  const env = fakeVscode(), cache = new Map(), states = [], reads = [], errors = [];
  env.settings.set('sourceInsightReader.projectSources', { mode: 'selected', directories: [], files: [] });
  const files = new Map([
    ['/project', [['kernel', 2], ['main.c', 1], ['external-link', 66]]],
    ['/project/kernel', [['sched', 2], ['a.c', 1]]],
    ['/project/kernel/sched', [['b.c', 1]]]
  ]);
  env.api.workspace.fs.readDirectory = async uri => { reads.push(uri.path); return files.get(uri.path) || []; };
  env.api.workspace.fs.stat = async uri => ({ type: files.has(uri.path) ? 2 : 1 });
  const panels = [];
  env.api.window.createWebviewPanel = () => {
    const dispose = new env.api.EventEmitter(), messages = new env.api.EventEmitter();
    const panel = { reveal() {}, onDidDispose: dispose.event, dispose() { dispose.fire(); }, webview: {
      cspSource: 'test:', asWebviewUri: uri => uri, onDidReceiveMessage: messages.event,
      async postMessage(message) { states.push(message.payload); }
    } };
    panels.push(panel); return panel;
  };
  env.api.window.showQuickPick = () => { throw new Error('Quick Pick must not be used'); };
  const load = file => loadWithVscode(require.resolve(file), env.api, cache);
  const catalog = new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
  const panel = new (load('../src/application/project-sources').ProjectSourcesPanel)(env.context, catalog, error => errors.push(error));
  t.after(() => { panel.dispose(); catalog.dispose(); });
  panel.show(); await panel.queue;
  const node = name => [...panel.nodes.values()].find(value => value.uri.path === '/project' + name);
  return { env, catalog, panel, panels, reads, files, errors, states, node };
}

test('independent panel lazily loads checkbox trees and keeps edits as a draft until save', async t => {
  const s = await fixture(t);
  assert.equal(s.panels.length, 1); assert.deepEqual(s.reads, []);
  assert.match(s.panels[0].webview.html, /role="tree"/);
  await s.panel.handle({ action: 'expand', id: s.node('').id });
  assert.deepEqual(s.reads, ['/project']); assert.equal(s.node('/external-link'), undefined);
  await s.panel.handle({ action: 'toggle', id: s.node('/main.c').id, type: true });
  assert.deepEqual(s.catalog.scope.selection().files, []);
  assert.equal(s.states.at(-1).rows.find(row => row.id === s.node('').id).partial, true);
  await s.panel.handle({ action: 'save' });
  assert.deepEqual(s.catalog.scope.selection(), { mode: 'selected', directories: [], files: ['main.c'] });
  s.panel.show(); assert.equal(s.panels.length, 1);
  await s.panel.handle({ action: 'clear' });
  await s.panel.handle({ action: 'close' }); s.panel.show(); await s.panel.queue;
  assert.deepEqual(s.panel.selection().files, ['main.c'], 'Closing discards unsaved changes');
});

test('directory checks compact descendants; right-pane unchecking synchronizes the tree and saved scope', async t => {
  const s = await fixture(t);
  await s.panel.handle({ action: 'expand', id: s.node('').id });
  await s.panel.handle({ action: 'expand', id: s.node('/kernel').id });
  await s.panel.handle({ action: 'toggle', id: s.node('/kernel/a.c').id, type: true });
  await s.panel.handle({ action: 'toggle', id: s.node('/kernel').id, type: true });
  assert.deepEqual(s.panel.selection(), { mode: 'selected', directories: ['kernel'], files: [] });
  const row = s.states.at(-1).rows.find(row => row.id === s.node('/kernel/a.c').id);
  assert.equal(row.checked, true); assert.equal(row.disabled, true);
  await s.panel.handle({ action: 'toggle', id: s.node('/kernel/a.c').id, type: false });
  assert.deepEqual(s.panel.selection().directories, ['kernel']);
  await s.panel.handle({ action: 'remove', id: s.node('/kernel').id });
  assert.equal(s.states.at(-1).rows.find(row => row.id === s.node('/kernel').id).checked, false);
  await s.panel.handle({ action: 'save' });
  assert.deepEqual(s.catalog.scope.selection(), { mode: 'selected', directories: [], files: [] });
});

test('panel rejects forged targets, paginates large directories and detects concurrent config changes', async t => {
  const s = await fixture(t);
  s.files.set('/project', Array.from({ length: 450 }, (_, i) => ['item-' + i + '.c', 1]));
  await s.panel.handle({ action: 'toggle', id: 'file:///external.c', type: true });
  assert.equal(s.panel.selected.size, 0);
  const root = s.node(''); await s.panel.handle({ action: 'expand', id: root.id });
  assert.equal(s.states.at(-1).rows.filter(row => !row.more).length, 201);
  assert.equal(s.states.at(-1).rows.at(-1).more, true);
  await s.panel.handle({ action: 'more', id: root.id });
  assert.equal(s.states.at(-1).rows.filter(row => !row.more).length, 401);
  await s.panel.handle({ action: 'toggle', id: s.node('/item-0.c').id, type: true });
  s.env.settings.set('sourceInsightReader.projectSources', { mode: 'workspace', directories: [], files: [] });
  await s.panel.handle({ action: 'save' });
  assert.match(s.states.at(-1).status, /其他位置改变/);
  assert.equal(s.catalog.scope.selection().mode, 'workspace');
  await s.panel.handle({ action: 'reload' });
  assert.equal(s.panel.whole, true);
});

test('checkbox renderer displays partial/inherited states and sends explicit changes', () => {
  const elements = new Map(), messages = []; let receive;
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.style = {}; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    setAttribute(name, value) { this[name] = value; }
    focus() {}
  }
  const document = { activeElement: undefined, createElement: () => new Element(), getElementById: id => {
    if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/project-sources.js'), 'utf8'), {
    document, window: { readerBridge: { t: text => text, postMessage: message => messages.push(message), onMessage: listener => { receive = listener; } } }
  });
  receive({ data: { scope: 'projectSources', whole: false, dirty: false, selected: [{ id: '2', path: '/a.c' }], rows: [
    { id: '1', name: '<kernel>', depth: 0, directory: true, partial: true },
    { id: '2', name: 'a.c', depth: 1, checked: true, disabled: true }
  ] } });
  const rows = elements.get('tree').children, check = rows[0].children[1].children[0];
  assert.equal(check.type, 'checkbox'); assert.equal(check.indeterminate, true);
  assert.equal(rows[1].children[1].children[0].disabled, true);
  assert.equal(rows[0].children[1].children[1].textContent, '<kernel>/');
  check.checked = true; check.handlers.change();
  assert.equal(messages.at(-1).action, 'toggle'); assert.equal(messages.at(-1).type, true);
  const lower = elements.get('selected').children[0].children[0];
  assert.equal(lower.checked, true); lower.checked = false; lower.handlers.change();
  assert.equal(messages.at(-1).action, 'remove'); assert.equal(messages.at(-1).id, '2');
  check.handlers.click({ shiftKey: true }); check.checked = false; check.handlers.change();
  assert.equal(messages.at(-1).action, 'range'); assert.equal(messages.at(-1).mode, 'tree');
  assert.equal(messages.at(-1).type, false);
  lower.handlers.click({ shiftKey: true }); lower.handlers.change();
  assert.equal(messages.at(-1).action, 'range'); assert.equal(messages.at(-1).mode, 'selected');
  assert(require('../shared/protocol').action(messages.at(-1), ['range']));
});

test('whole-workspace selection appears in the right pane and can be unchecked without falling back to full scanning', async t => {
  const s = await fixture(t);
  await s.panel.handle({ action: 'whole', type: true });
  assert.equal(s.states.at(-1).selected.length, 1);
  await s.panel.handle({ action: 'remove', id: s.node('').id });
  assert.equal(s.panel.whole, false); assert.equal(s.panel.selected.size, 0);
  await s.panel.handle({ action: 'save' });
  assert.deepEqual(await s.catalog.list(), []);
});

test('folder mapping chooser saves drafts, cancels without changes and rejects foreign source targets', async t => {
  const s = await fixture(t);
  const choices = ['/build', '/project', '/another-build', '/foreign'];
  s.env.api.window.showOpenDialog = async options => {
    assert.equal(options.canSelectFolders, true); assert.equal(options.canSelectFiles, false);
    const name = choices.shift(); return name ? [s.env.api.Uri.file(name)] : undefined;
  };
  await s.panel.handle({ action: 'addMapping' });
  assert.deepEqual(s.panel.selection().pathMappings, [{ from: '/build', to: '/project' }]);
  assert.equal(s.catalog.scope.selection().pathMappings, undefined);
  await s.panel.handle({ action: 'save' });
  assert.deepEqual(s.catalog.scope.selection().pathMappings, [{ from: '/build', to: '/project' }]);
  await s.panel.handle({ action: 'addMapping' });
  assert.match(s.states.at(-1).status, /工作区/);
  await s.panel.handle({ action: 'addMapping' });
  assert.equal(s.panel.pathMappings.length, 1);
  await s.panel.handle({ action: 'removeMapping', id: '0' });
  assert.equal(s.panel.selection().pathMappings, undefined);
});

test('compilation mode cannot accidentally clear imported selection and a running start prevents mutation', async t => {
  const s = await fixture(t);
  await s.panel.handle({ action: 'mode', mode: 'compilation' });
  await s.panel.handle({ action: 'clear' });
  assert.equal(s.panel.mode, 'compilation');
  s.panel.starting = true;
  await s.panel.handle({ action: 'mode', mode: 'workspace' });
  assert.equal(s.panel.mode, 'compilation');
  assert.match(s.states.at(-1).status, /索引处理中/);
  s.panel.starting = false;
  s.env.settings.set('sourceInsightReader.projectSources', { mode: 'workspace', directories: [], files: [] });
  s.env.events.configuration.fire({ affectsConfiguration: key => key === 'sourceInsightReader.projectSources' });
  assert(s.panel.conflict); assert.match(s.states.at(-1).status, /其他位置改变/);
});

test('Shift ranges select and clear visible files in both directions with one draft update', async t => {
  const s = await fixture(t);
  s.files.set('/project', ['a.c', 'b.c', 'c.c', 'd.c', 'e.c'].map(name => [name, 1]));
  await s.panel.handle({ action: 'expand', id: s.node('').id });
  const toggle = (name, type) => s.panel.handle({ action: 'toggle', id: s.node('/' + name).id, type });
  const range = (name, type) => s.panel.handle({ action: 'range', mode: 'tree', id: s.node('/' + name).id, type });
  await toggle('a.c', true);
  const before = s.states.length;
  await range('c.c', true);
  assert.equal(s.states.length, before + 1, 'A range publishes one atomic draft update');
  assert.deepEqual(s.panel.selection().files.sort(), ['a.c', 'b.c', 'c.c']);
  await toggle('e.c', true); await range('b.c', true);
  assert.deepEqual(s.panel.selection().files.sort(), ['a.c', 'b.c', 'c.c', 'd.c', 'e.c']);
  assert.deepEqual(s.catalog.scope.selection().files, [], 'Range selection does not save or start indexing');
  await toggle('a.c', false); await range('e.c', false);
  assert.deepEqual(s.panel.selection().files, []);
});

test('the selected pane retains its removed anchor for Shift cancellation', async t => {
  const s = await fixture(t);
  s.files.set('/project', ['a.c', 'b.c', 'c.c', 'd.c', 'e.c'].map(name => [name, 1]));
  await s.panel.handle({ action: 'expand', id: s.node('').id });
  await s.panel.handle({ action: 'toggle', id: s.node('/a.c').id, type: true });
  await s.panel.handle({ action: 'range', mode: 'tree', id: s.node('/e.c').id, type: true });
  await s.panel.handle({ action: 'remove', id: s.node('/b.c').id });
  assert(!s.states.at(-1).selected.some(row => row.id === s.node('/b.c').id));
  await s.panel.handle({ action: 'range', mode: 'selected', id: s.node('/d.c').id, type: false });
  assert.deepEqual(s.panel.selection().files, ['a.c', 'e.c']);
  assert.equal(s.states.at(-1).selected[0].label, 'a.c', 'Narrow right panes display relative labels with absolute path tooltips');
  await s.panel.handle({ action: 'remove', id: s.node('/e.c').id });
  await s.panel.handle({ action: 'range', mode: 'selected', id: s.node('/a.c').id, type: false });
  assert.deepEqual(s.panel.selection().files, []);
});

test('Shift selection skips inherited children and never includes collapsed items or forged endpoints', async t => {
  const s = await fixture(t);
  await s.panel.handle({ action: 'expand', id: s.node('').id });
  await s.panel.handle({ action: 'expand', id: s.node('/kernel').id });
  await s.panel.handle({ action: 'toggle', id: s.node('/kernel/a.c').id, type: true });
  await s.panel.handle({ action: 'expand', id: s.node('/kernel').id });
  await s.panel.handle({ action: 'range', mode: 'tree', id: s.node('/main.c').id, type: true });
  assert.deepEqual(s.panel.selection().files.sort(), ['kernel/a.c', 'main.c']);
  await s.panel.handle({ action: 'toggle', id: s.node('/kernel').id, type: true });
  await s.panel.handle({ action: 'expand', id: s.node('/kernel').id });
  await s.panel.handle({ action: 'range', mode: 'tree', id: s.node('/main.c').id, type: true });
  assert.deepEqual(s.panel.selection().directories, ['kernel']);
  assert.deepEqual(s.panel.selection().files, ['main.c']);
  const previous = s.panel.selection();
  await s.panel.handle({ action: 'range', mode: 'tree', id: 'file:///outside.c', type: true });
  await s.panel.handle({ action: 'range', mode: 'invalid', id: s.node('').id, type: true });
  assert.deepEqual(s.panel.selection(), previous);
  await s.panel.handle({ action: 'reload' });
  await s.panel.handle({ action: 'range', mode: 'tree', id: s.node('').id, type: true });
  assert.deepEqual(s.panel.selection().directories, ['.'], 'A Shift click without an anchor behaves like a single click');
});
