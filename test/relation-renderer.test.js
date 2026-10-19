'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Relation renderer uses text nodes, preserves the Context column and persists draggable splitter proportions', () => {
  let document;
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.handlers = {}; this.className = ''; this.attributes = {}; this.style = {}; this.scrollTop = 0;
      this.classList = { add: value => { this.className += ` ${value}`; }, toggle: (value, enabled) => { if (enabled) this.className += ` ${value}`; else this.className = this.className.split(' ').filter(part => part !== value).join(' '); }, remove: value => { this.className = this.className.split(' ').filter(part => part !== value).join(' '); } };
    }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; if (name === 'class') this.className = value; }
    append(...values) { this.children.push(...values); }
    replaceChildren(...values) { this.children = values; }
    set textContent(value) { this.children = [String(value)]; }
    get textContent() { return this.children.map(value => typeof value === 'string' ? value : value.textContent).join(''); }
    set innerHTML(value) { throw new Error(`Unsafe HTML ${value}`); }
    querySelectorAll(selector) {
      const result = [];
      for (const child of this.children.filter(value => typeof value !== 'string')) {
        if (child.className.split(' ').includes(selector.slice(1))) result.push(child);
        result.push(...child.querySelectorAll(selector));
      }
      return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0]; }
    contains(element) { return element === this || this.children.some(child => typeof child !== 'string' && child.contains(element)); }
    focus() { document.activeElement = this; }
    setPointerCapture(id) { this.pointer = id; }
    hasPointerCapture(id) { return this.pointer === id; }
    getBoundingClientRect() { return { left: 0, width: 1000 }; }
  }
  const elements = new Map(), messages = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  document = { body: new Element('body'), activeElement: undefined, getElementById: get, createElement: tag => new Element(tag), createElementNS: (ns, tag) => new Element(tag) };
  let receive, saved = { readingSplit: 55 };
  const sandbox = {
    document, window: { sourceInsightReaderApi: { onMessage: callback => { receive = callback; }, postMessage: value => messages.push(value), getState: () => saved, setState: value => { saved = value; } },
      addEventListener(name, handler) { if (name === 'message') receive = handler; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/relation-layout.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/relation.js'), 'utf8'), sandbox);
  assert.match(document.body.style.gridTemplateColumns, /55fr/);
  receive({ data: { scope: 'index', phase: 'building', busy: true, message: '索引创建中… 16/80 个文件' } });
  assert.equal(get('relation-index-status').textContent, '索引创建中… 16/80 个文件');
  assert.equal(get('relation-index-status').attributes['aria-busy'], 'true');
  receive({ data: { scope: 'index', phase: 'ready', busy: false, message: '本地 C 索引：80 个文件' } });
  assert.equal(get('relation-index-status').attributes['aria-busy'], 'false');

  receive({ data: { scope: 'relation', description: '谁调用它', direction: 'incoming', rows: [
    { id: '1', type: 'relation', label: '<script>literal</script>', description: 'calls.c:1', children: [], expandable: true, expanded: false }
  ] } });
  assert.match(get('relation-tree').textContent, /<script>literal<\/script>/);
  const row = get('relation-tree').querySelector('.relation-row'); row.handlers.click();
  assert.equal(messages.at(-1).action, 'relation.select'); assert.equal(messages.at(-1).id, '1');
  receive({ data: { scope: 'relation', selectionOnly: true, selectedId: '1' } });
  assert.equal(get('relation-tree').querySelector('.relation-row'), row);
  get('relation-open').handlers.click(); assert.equal(messages.at(-1).action, 'relation.open');
  const splitter = get('reading-splitter');
  splitter.handlers.pointerdown({ pointerId: 1, preventDefault() {} });
  splitter.handlers.pointermove({ pointerId: 1, clientX: 700 }); splitter.handlers.pointerup();
  assert.equal(saved.readingSplit, 70); assert.match(document.body.style.gridTemplateColumns, /70fr/);
  splitter.handlers.keydown({ key: 'ArrowLeft', preventDefault() {} }); assert.equal(saved.readingSplit, 68);
  receive({ data: { scope: 'relation', focus: true } }); assert.equal(document.activeElement, get('relation-tree'));
  const graphNode = (id, label, siteCount = 0) => ({ id, label, type: 'relation', description: 'calls.c:1', siteCount });
  receive({ data: { scope: 'relation', viewMode: 'horizontalGraph', rows: [], graph: {
    root: graphNode('center', 'current'), incoming: [graphNode('caller', '<script>caller</script>', 2)],
    outgoing: [graphNode('leaf', 'leaf', 1)], incomingCount: 1, outgoingCount: 1
  } } });
  assert.equal(get('relation-tree').attributes.role, 'group');
  assert.equal(get('relation-incoming').hidden, true); assert.equal(get('relation-collapse').hidden, true);
  assert.match(get('relation-tree').textContent, /调用者（1）/); assert.match(get('relation-tree').textContent, /<script>caller<\/script>/);
  assert.equal(get('relation-tree').querySelectorAll('.relation-graph-edge').length, 2);
  const graphRows = get('relation-tree').querySelectorAll('.relation-row');
  assert.equal(graphRows.length, 3); graphRows[0].handlers.click();
  assert.equal(messages.at(-1).action, 'relation.select'); assert.equal(messages.at(-1).id, 'caller');
  get('relation-tree').querySelectorAll('.relation-graph-sites')[0].handlers.click();
  assert.equal(messages.at(-1).action, 'relation.sites'); assert.equal(messages.at(-1).id, 'caller');
  graphRows[2].handlers.dblclick(); assert.equal(messages.at(-1).action, 'relation.open');
  graphRows[1].handlers.keydown({ key: 'ArrowRight', preventDefault() {} }); assert.equal(document.activeElement, graphRows[2]);
  get('relation-view').handlers.click(); assert.equal(messages.at(-1).action, 'relation.view');
  receive({ data: { scope: 'relation', viewMode: 'outline', rows: [] } });
  assert.equal(get('relation-incoming').hidden, false); assert.equal(get('relation-collapse').hidden, false);
});

test('horizontal graph layout grows left to right with one-level edges and handles many callers and narrow panes', () => {
  const { layoutGraph } = require('../media/relation-layout');
  const row = id => ({ id, type: 'relation' });
  const layout = layoutGraph(Array.from({ length: 29 }, (_, i) => row(`caller-${i}`)), row('root'), [row('callee')], 400);
  assert.equal(layout.width, 560); assert.equal(layout.nodes.length, 31); assert.equal(layout.edges.length, 30);
  const root = layout.center, left = layout.nodes[0], right = layout.nodes.at(-1);
  assert(left.x + left.width < root.x); assert(root.x + root.width < right.x);
  assert.equal(layout.edges[0].to, 'root'); assert.equal(layout.edges.at(-1).from, 'root');
  for (const node of layout.nodes) assert(node.y >= 34 && node.y + node.height < layout.height);
  const empty = layoutGraph([{ id: 'empty', type: 'message' }], row('root'), [], 800);
  assert.equal(empty.edges.length, 0); assert.equal(empty.nodes.length, 2);
});
