'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { functionHeads, emphasizeHeads } = require('../src/function-heads');
const { highlightLine } = require('../src/syntax');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('function emphasis stops at the name and preserves parameters, body and source text', () => {
  const env = fakeVscode(), text = 'static const struct Sensor *read_sensor(int value) { return value; }';
  const document = env.document('head.c', text), name = text.indexOf('read_sensor');
  const nodes = [{ kind: 11, range: new env.api.Range(0, 0, 0, text.length),
    selectionRange: new env.api.Range(0, name, 0, name + 'read_sensor'.length), children: [] }];
  const heads = functionHeads(nodes, document), tokens = emphasizeHeads(highlightLine(text), 0, heads);
  assert.equal(tokens.map(token => token.text).join(''), text);
  assert.equal(tokens.filter(token => token.strong).map(token => token.text).join(''), 'static const struct Sensor *read_sensor');
  assert(!tokens.filter(token => token.strong).some(token => token.text.includes('value')));
  assert.equal(functionHeads([{ ...nodes[0], selectionRange: nodes[0].range }], document).length, 0);
});

test('multiline function heads preserve comments and stop before the parameter list', () => {
  const env = fakeVscode(), document = env.document('head.c', 'static struct Sensor *\nread_sensor(int value) { return 0; }');
  const heads = functionHeads([{ kind: 11, range: new env.api.Range(0, 0, 1, 35),
    selectionRange: new env.api.Range(1, 0, 1, 11) }], document);
  const first = emphasizeHeads(highlightLine('static /* comment */ struct Sensor *'), 0, heads);
  assert(first.some(token => token.text === 'Sensor' && token.strong));
  assert(first.filter(token => token.kind === 'comment').every(token => !token.strong));
  const second = emphasizeHeads(highlightLine(document.lineAt(1).text), 1, heads);
  assert.equal(second.filter(token => token.strong).map(token => token.text).join(''), 'read_sensor');
});

test('editor emphasis follows the Source Insight theme and invalidates ranges after edits', () => {
  const env = fakeVscode(), events = new env.api.EventEmitter(), applied = [];
  const document = env.document('head.c', 'int run(void) { return 0; }');
  env.api.window.visibleTextEditors = [{ document, setDecorations(type, ranges) { applied.push({ type, ranges }); } }];
  const symbols = { uri: document.uri, nodes: [{ kind: 11, range: new env.api.Range(0, 0, 0, 26),
    selectionRange: new env.api.Range(0, 4, 0, 7) }], onDidChangeTreeData: events.event };
  const { FunctionHeadStyle } = loadWithVscode('../src/function-head-style', env.api);
  const style = new FunctionHeadStyle(symbols);
  const ranges = type => applied.filter(value => value.type === type).at(-1).ranges;
  try {
    events.fire(); assert.equal(ranges(style.decoration).length, 0);
    env.settings.set('workbench.colorTheme', 'SourceInsight-Reader Source Insight');
    env.events.configuration.fire({ affectsConfiguration: key => key === 'workbench.colorTheme' });
    assert.equal(ranges(style.decoration)[0].end.character, 7);
    assert.equal(ranges(style.nameDecoration)[0].start.character, 4);
    assert.equal(ranges(style.nameDecoration)[0].end.character, 7);
    assert.equal(ranges(style.parameterDecoration)[0].start.character, 7);
    document.version++;
    env.events.document.fire({ document }); assert.equal(ranges(style.nameDecoration).length, 0);
    events.fire(); assert.equal(ranges(style.nameDecoration).length, 1);
    env.settings.set('workbench.colorTheme', 'Other theme');
    env.events.configuration.fire({ affectsConfiguration: () => true });
    assert.equal(ranges(style.nameDecoration).length, 0);
    assert.equal(ranges(style.parameterDecoration).length, 0);
  } finally { style.dispose(); }
});

test('only declaration and definition names are enlarged, and nested callback parameters stop at the correct parenthesis', () => {
  const env = fakeVscode(), text = 'int first(void); int second(int (*callback)(int)) { return first(); }';
  const document = env.document('head.c', text);
  const nodes = ['first', 'second'].map(name => ({ kind: 11,
    range: new env.api.Range(0, text.indexOf(name) - 4, 0, text.length),
    selectionRange: new env.api.Range(0, text.indexOf(name), 0, text.indexOf(name) + name.length) }));
  const heads = functionHeads(nodes, document), tokens = emphasizeHeads(highlightLine(text), 0, heads);
  assert.equal(tokens.filter(token => token.emphasis === 'function-name').map(token => token.text).join(','), 'first,second');
  assert.equal(tokens.filter(token => token.emphasis === 'function-parameters').map(token => token.text).join(''), '(void)(int (*callback)(int))');
  assert(tokens.some(token => token.text === 'first' && !token.emphasis));
});

test('Context asynchronously emphasizes the function head while retaining navigation tokens', async () => {
  const env = fakeVscode(), document = env.document('head.c', 'int run(void) { return 0; }');
  const { ContextView } = loadWithVscode('../src/context', env.api);
  const view = new ContextView({ symbols: async () => [{ kind: 11, range: new env.api.Range(0, 0, 0, 26),
    selectionRange: new env.api.Range(0, 4, 0, 7) }] }, () => {});
  try {
    await view.show({ uri: document.uri, range: new env.api.Range(0, 4, 0, 7) });
    await new Promise(resolve => setImmediate(resolve));
    const tokens = view.state.lines[0].tokens;
    assert.equal(tokens.filter(token => token.strong).map(token => token.text).join(''), 'int run');
    assert.equal(tokens.find(token => token.text === 'run').kind, 'function');
  } finally { view.dispose(); }
});
