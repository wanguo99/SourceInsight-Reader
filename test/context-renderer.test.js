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
    setAttribute(name, value) { this[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    set textContent(text) { this.children = [String(text)]; }
    get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    set innerHTML(value) { throw new Error(`Source must never be injected as HTML: ${value}`); }
    querySelectorAll(selector) { return this.children.filter(child => child.className?.split(' ').includes(selector.slice(1))); }
    get classList() { return { toggle: () => {} }; }
    focus() { document.activeElement = this; }
    querySelector() { return { scrollIntoView() {} }; }
  }
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const messages = []; let receive; const windowHandlers = {};
  const document = { getElementById: get, createElement: tag => new Element(tag), createTextNode: text => String(text) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/context.js'), 'utf8'), {
    document, window: { readerBridge: { postMessage: message => messages.push(message), onMessage: callback => { receive = callback; } }, sourceInsightSymbolMatches: require('../media/symbol-matches'), getSelection: () => 'next', addEventListener(event, handler) { windowHandlers[event] = handler; if (event === 'message') receive = handler; } },
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) })
  });
  const source = '<script>alert("never execute")</script>';
  receive({ data: { status: '定义', path: 'C:\\项目\\a.cpp', candidates: [], lines: [
    { number: 7, text: source, start: 8, end: 13, active: true, tokens: [{ text: source, kind: 'comment' }] }
  ], locked: false, canOpen: true } });
  assert.equal(get('code').children[0].textContent, '7' + source);
  get('context-find').value = '7'; get('context-find').handlers.input();
  assert.equal(get('find-count').textContent, '0', 'Find must not match the displayed line number');
  get('context-find').value = 'script'; get('context-find').handlers.input();
  assert.equal(get('find-count').textContent, '1');
  receive({ data: { scope: 'index', message: '索引更新中…' } });
  assert.equal(get('code').children[0].textContent, '7' + source);
  assert.equal(get('status').textContent, '定义');
  assert.equal(get('metadata').hidden, true);
  assert.equal(get('path').title, 'C:\\项目\\a.cpp');
  assert.equal(get('path').textContent, '· a.cpp');
  get('code').handlers.dblclick();
  get('code').handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(messages.map(message => message.action), ['ready', 'open', 'open']);
  receive({ data: { candidates: [], snapshot: 42, highlightSymbol: 'next', lines: [
    { number: 9, text: '  next', start: -1, end: -1, tokens: [{ text: '  ', kind: 'plain' }, { text: 'next', kind: 'function' }] }
  ], locked: false, canOpen: true } });
  const link = get('code').children[0].children[2];
  assert.equal(link.tabindex, '0');
  assert.equal(link.children[0].className, 'symbol-match');
  assert.equal(link.textContent, 'next');
  windowHandlers.keydown({ ctrlKey: true });
  assert.equal(get('code')['data-control-hover'], 'true');
  windowHandlers.keyup({ ctrlKey: false });
  assert.equal(get('code')['data-control-hover'], 'false');
  get('code').handlers.mousemove({ ctrlKey: true });
  assert.equal(get('code')['data-control-hover'], 'true');
  windowHandlers.blur();
  assert.equal(get('code')['data-control-hover'], 'false');
  link.handlers.click({ preventDefault() {}, stopPropagation() {}, shiftKey: true });
  assert.equal(messages.at(-1).action, 'navigate');
  assert.equal(messages.at(-1).line, 8); assert.equal(messages.at(-1).character, 2);
  assert.equal(messages.at(-1).snapshot, 42); assert.equal(messages.at(-1).type, true);
  windowHandlers.keydown({ key: 'h', ctrlKey: true, altKey: true, preventDefault() {} });
  assert.equal(messages.at(-1).action, 'highlightSymbol');
  assert.equal(messages.at(-1).symbol, 'next');
  const beforeHighlight = messages.length;
  windowHandlers.keydown({ key: 'F2', preventDefault() {} });
  assert.equal(messages.length, beforeHighlight, 'F2 remains opt-in');
  windowHandlers.keydown({ key: 'F8', altKey: true, preventDefault() {} });
  windowHandlers.keydown({ key: 'F8', shiftKey: true, preventDefault() {} });
  assert.equal(messages.length, beforeHighlight, 'modified F8 must not toggle highlighting');
  windowHandlers.keydown({ key: 'F8', preventDefault() {} });
  assert.equal(messages.length, beforeHighlight + 1);
  assert.equal(messages.at(-1).action, 'highlightSymbol');
  receive({ data: { highlightUseF2: true, candidates: [], lines: [] } });
  windowHandlers.keydown({ key: 'F2', preventDefault() {} });
  assert.equal(messages.length, beforeHighlight + 2);
  get('highlight').handlers.click(); assert.equal(messages.at(-1).symbol, 'next');
  receive({ data: { candidates: [], lines: [], locked: true, canOpen: false, canBack: false, canForward: false } });
  assert.equal(get('back').disabled, false); assert.equal(get('forward').disabled, false);
  get('back').handlers.click(); get('forward').handlers.click();
  assert.deepEqual(messages.slice(-2).map(message => message.action), ['editorBack', 'editorForward']);
  const before = messages.length;
  for (const button of [3, 4]) {
    for (const type of ['mousedown', 'mouseup', 'auxclick'])
      get('code').handlers[type]({ button, preventDefault() {}, stopPropagation() {} });
  }
  assert.deepEqual(messages.slice(before).map(message => message.action), ['back', 'forward']);
  receive({ data: { scope: 'index', busy: true, message: '索引创建中…' } });
  assert.equal(get('rebuildIndex').disabled, true);
  assert.equal(get('rebuildIndex').textContent, '索引处理中…');
  receive({ data: { scope: 'index', busy: false, phase: 'ready', message: '索引已更新' } });
  assert.equal(get('rebuildIndex').disabled, false);
  assert.equal(get('rebuildIndex').textContent, '重建索引');
  get('rebuildIndex').handlers.click();
  assert.equal(messages.at(-1).action, 'rebuildIndex');
  const labels = ['drivers/a/device.c:12:5', 'drivers/b/device.c:42:1', '<unsafe>.c:9:2'];
  const renderCandidates = overrides => receive({ data: { candidates: labels, lines: [], locked: false, snapshot: 73, candidateIndex: -1, ...overrides } });
  renderCandidates();
  assert.equal(get('metadata').hidden, false);
  const buttons = get('candidates').children.map(row => row.children[0]);
  assert.deepEqual(buttons.map(button => button.textContent), labels);
  assert.equal(buttons[2].title, labels[2], 'Paths are literal text, including markup characters');
  buttons[1].handlers.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { action: 'candidate', index: 1, snapshot: 73 });
  buttons[1].focus(); get('candidates').scrollTop = 42;
  renderCandidates({ snapshot: 74, candidateIndex: 1 });
  assert.equal(get('candidates').children[1].children[0], buttons[1], 'Syntax updates preserve candidate buttons');
  assert.equal(document.activeElement, buttons[1]);
  assert.equal(get('candidates').scrollTop, 42);
  assert.equal(buttons[1]['aria-pressed'], 'true');
  buttons[1].handlers.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(document.activeElement, buttons[2]);
  buttons[2].handlers.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(document.activeElement, buttons[0]);
  buttons[0].handlers.click(); assert.equal(messages.at(-1).snapshot, 74);
  renderCandidates({ locked: true });
  const lockedCount = messages.length;
  buttons[0].handlers.click(); assert.equal(messages.length, lockedCount);
  assert.ok(buttons.every(button => button.disabled));
  renderCandidates({ candidates: ['a.c:1:1'] });
  assert.equal(get('metadata').hidden, true);
  const includeText = '#include "dir/my-header.v2.h"';
  receive({ data: { candidates: [], snapshot: 81, locked: false, lines: [{ number: 4, text: includeText, start: -1, end: -1,
    includeRange: { start: 10, end: includeText.length - 1 },
    tokens: [{ text: '#include ', kind: 'preprocessor' }, { text: '"dir/my-header.v2.h"', kind: 'string' }] }] } });
  const headerLink = get('code').children[0].children[2];
  assert.equal(headerLink.role, 'link'); assert.equal(headerLink.textContent, '"dir/my-header.v2.h"');
  headerLink.handlers.click({ preventDefault() {}, stopPropagation() {}, shiftKey: true });
  assert.equal(messages.at(-1).action, 'navigate'); assert.equal(messages.at(-1).line, 3);
  assert.equal(messages.at(-1).character, 10); assert.equal(messages.at(-1).snapshot, 81); assert.equal(messages.at(-1).type, false);
});
