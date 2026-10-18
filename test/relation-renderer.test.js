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
      this.classList = { add: value => { this.className += ` ${value}`; }, remove: value => { this.className = this.className.split(' ').filter(part => part !== value).join(' '); } };
    }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
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
  document = { body: new Element('body'), activeElement: undefined, getElementById: get, createElement: tag => new Element(tag) };
  let receive, saved = { readingSplit: 55 };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/relation.js'), 'utf8'), {
    document, window: { sourceReaderApi: { postMessage: value => messages.push(value), getState: () => saved, setState: value => { saved = value; } },
      addEventListener(name, handler) { if (name === 'message') receive = handler; } }
  });
  assert.match(document.body.style.gridTemplateColumns, /55fr/);
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
});
