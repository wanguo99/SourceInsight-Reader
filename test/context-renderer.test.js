'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Context renders source as literal DOM text and provides Source Insight double-click/Enter opening', () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.className = ''; this.value = ''; }
    addEventListener(event, handler) { this.handlers[event] = handler; }
    setAttribute() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    set textContent(text) { this.children = [String(text)]; }
    get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    set innerHTML(value) { throw new Error(`Source must never be injected as HTML: ${value}`); }
    querySelector() { return { scrollIntoView() {} }; }
  }
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const messages = []; let receive;
  const document = { getElementById: get, createElement: tag => new Element(tag), createTextNode: text => String(text) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/context.js'), 'utf8'), {
    document, window: { addEventListener(event, handler) { if (event === 'message') receive = handler; } },
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) })
  });
  const source = '<script>alert("never execute")</script>';
  receive({ data: { status: '定义', path: 'C:\\项目\\a.cpp', candidates: [], lines: [
    { number: 7, text: source, start: 8, end: 13, active: true, tokens: [{ text: source, kind: 'comment' }] }
  ], locked: false, canOpen: true } });
  assert.equal(get('code').children[0].textContent, '7' + source);
  get('code').handlers.dblclick();
  get('code').handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(messages.map(message => message.action), ['ready', 'open', 'open']);
  receive({ data: { candidates: [], snapshot: 42, lines: [
    { number: 9, text: '  next', start: -1, end: -1, tokens: [{ text: '  ', kind: 'plain' }, { text: 'next', kind: 'function' }] }
  ], locked: false, canOpen: true } });
  const link = get('code').children[0].children[2];
  link.handlers.click({ preventDefault() {}, stopPropagation() {}, shiftKey: true });
  assert.equal(messages.at(-1).action, 'navigate');
  assert.equal(messages.at(-1).line, 8); assert.equal(messages.at(-1).character, 2);
  assert.equal(messages.at(-1).snapshot, 42); assert.equal(messages.at(-1).type, true);
  const before = messages.length;
  for (const button of [3, 4]) {
    for (const type of ['mousedown', 'mouseup', 'auxclick'])
      get('code').handlers[type]({ button, preventDefault() {}, stopPropagation() {} });
  }
  assert.deepEqual(messages.slice(before).map(message => message.action), ['back', 'forward']);


});
