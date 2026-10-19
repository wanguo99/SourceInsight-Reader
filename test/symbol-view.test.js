'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('symbol webview shows file tab, filters immediately, retains parents, opens exact symbols and rejects obsolete rows', async () => {
  const env = fakeVscode(), updates = [], opened = [], errors = [];
  const { SymbolTree } = loadWithVscode('../src/trees', env.api);
  const { SymbolView } = loadWithVscode('../src/symbol-view', env.api);
  const doc = env.document('目录/catalog.c');
  const range = line => new env.api.Range(line, 0, line, 6);
  const model = new SymbolTree({ symbols: async () => [
    { type: 'symbol', name: 'Catalog', kind: 22, uri: doc.uri, range: range(0), selectionRange: range(0), children: [
      { type: 'symbol', name: 'cached_value', kind: 7, uri: doc.uri, range: range(1), selectionRange: range(1), children: [] }
    ] },
    { type: 'symbol', name: 'Main', kind: 11, uri: doc.uri, range: range(5), selectionRange: range(5), children: [] }
  ] });
  const view = new SymbolView(env.context.extensionUri, model, node => opened.push(node), async query => {
    model.query = query; model.refresh();
  }, error => errors.push(error));
  const emitter = new env.api.EventEmitter();
  const webview = { cspSource: 'test:', asWebviewUri: uri => uri, onDidReceiveMessage: emitter.event,
    async postMessage(state) { updates.push(state.payload); } };
  view.resolveWebviewView({ visible: true, webview, onDidChangeVisibility: emitter.event, onDidDispose: new env.api.EventEmitter().event });
  assert.match(webview.html, /class="file-tab"/); assert.match(webview.html, /id="search"/);
  await model.load(doc.uri); await view.publish();
  assert.equal(updates.at(-1).filename, 'catalog.c'); assert.equal(updates.at(-1).rows.length, 3);
  assert.deepEqual(updates.at(-1).rows.map(row => row.iconKind), ['struct', 'member', 'function']);
  assert.match(updates.at(-1).rows[0].icon, /symbol-icons\/struct\.svg$/);
  assert.match(updates.at(-1).rows[1].tooltip, /^成员：/);
  const oldId = updates.at(-1).rows[2].id;
  await view.handleMessage({ action: 'filter', query: 'CACHED' });
  assert.deepEqual(updates.at(-1).rows.map(row => row.label), ['Catalog', 'cached_value']);
  await view.handleMessage({ action: 'open', id: oldId }); assert.equal(opened.length, 0);
  await view.handleMessage({ action: 'open', id: updates.at(-1).rows[1].id });
  assert.equal(opened[0].selectionRange.start.line, 1);
  await view.handleMessage({ action: 'filter', query: '' });
  assert.equal(updates.at(-1).rows.length, 3);
  await view.handleMessage({ action: 'toggle', id: updates.at(-1).rows[0].id });
  assert.equal(updates.at(-1).rows.length, 2);
  const parent = model.displayed[0], child = parent.children[0];
  await view.reveal(child, { select: true });
  assert.equal(updates.at(-1).rows.length, 3); assert.equal(updates.at(-1).rows[1].selected, true);
  assert.equal(errors.length, 0); view.dispose(); model.dispose();
});

test('symbol renderer keeps file text safe and sends live search with IME and clear support', () => {
  let receive; const messages = [], elements = new Map();
  const document = { activeElement: null, getElementById: id => {
    if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id);
  }, createElement: () => new Element() };
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.value = ''; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    set innerHTML(value) { throw new Error('HTML injection'); }
    focus() { document.activeElement = this; }
    querySelector() { return null; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/symbols.js'), 'utf8'), {
    document, window: { readerBridge: { postMessage: message => messages.push(message), onMessage: callback => { receive = callback; } } },
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) })
  });
  receive({ data: { filename: '<script>.c', path: '/目录/<script>.c', query: '', rows: [], summary: '0 项', message: '无匹配符号' } });
  assert.equal(elements.get('filename').textContent, '<script>.c');
  const search = elements.get('search'); search.focus(); search.value = 'main'; search.handlers.input();
  assert.equal(messages.at(-1).query, 'main');
  search.handlers.compositionstart(); search.value = '宏'; const count = messages.length; search.handlers.input();
  assert.equal(messages.length, count); search.handlers.compositionend(); assert.equal(messages.at(-1).query, '宏');
  elements.get('clear').handlers.click(); assert.equal(messages.at(-1).query, '');
  receive({ data: { filename: 'other.h', path: '/other.h', query: '', summary: '1 项', rows: [
    { id: '1', key: 'symbol-1', depth: 0, label: '<script>symbol', category: '函数', icon: 'local/function.svg', tooltip: '路径', selected: false }
  ] } });
  const row = elements.get('symbols').children[0].children[0].children[2];
  assert.equal(row.children[0].src, 'local/function.svg');
  assert.equal(row.children[0].className, 'symbol-icon');
  assert.equal(row.children[0]['aria-hidden'], 'true');
  assert.equal(row.children[1].textContent, '<script>symbol');
  row.handlers.click({ altKey: false }); assert.equal(messages.at(-1).action, 'open');
  row.handlers.click({ altKey: true }); assert.equal(messages.at(-1).action, 'preview');
  row.handlers.contextmenu({ preventDefault() {} }); assert.equal(messages.at(-1).action, 'menu');
});
