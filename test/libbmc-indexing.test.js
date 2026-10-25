'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { cSourceProjection } = require('../src/infrastructure/c-source-projection');
let parser;
test.before(async () => { parser = await createParser(); });
test.after(() => parser.delete());
const parse = (source, name = 'reader.c') => ({ ...parseC(parser, source, 'file:///project/' + name, '/project/' + name), project: 'file:///project' });

test('conditional braces spanning matching feature guards retain the enclosing function and locals', () => {
  const source = 'int collect(int round) {\n#if HAS_COLLECTOR\n  if (!round) {\n#endif\n    int value = 1;\n' +
    '#if HAS_COLLECTOR\n    value = work(value);\n  }\n#else\n  fallback();\n#endif\n  return round;\n}\n';
  const projected = cSourceProjection(source), facts = parse(source), index = new CIndex(); index.replace([facts]);
  assert.equal(projected.length, source.length); assert.equal(facts.hasErrors, false);
  assert.deepEqual(facts.functions.map(fn => fn.name), ['collect']);
  assert(!facts.symbols.some(node => node.name === 'value'), 'locals cannot leak as global declarations');
  assert.equal(index.definitions(facts.uri, { line: 6, character: 17 })[0].selectionRange.start.line, 4);
  assert.deepEqual(facts.calls.map(call => call.name), ['work', 'fallback']);
  assert.equal(cSourceProjection(source, { keepDirectives: true }), source, 'macro extraction keeps the original conditional environment');
  assert.equal(projected, source, 'the normal projection is preserved; block recovery is opt-in');
});

test('function-body projection preserves known C++ exclusion and unknown top-level alternatives', () => {
  const source = '#if TOP\nint first(void){\n#if FEATURE\n return 1;\n#else\n return 2;\n#endif\n}\n#else\nint second(void){return 3;}\n#endif\n' +
    'int api(void){\n#ifdef __cplusplus\n class Hidden {};\n#else\n return first();\n#endif\n}';
  const facts = parse(source); assert.equal(facts.hasErrors, false);
  assert.deepEqual(facts.functions.map(fn => fn.name), ['first', 'second', 'api']);
  assert(!facts.symbols.some(node => node.name === 'Hidden'));
});

test('unnamed missing punctuation has an exact recovery position for macro-style loops', () => {
  const source = 'int visit(void *array){\n  void *item;\n  cJSON_ArrayForEach(item, array)\n  { use(item); }\n  return 0;\n}';
  const facts = parse(source); assert.equal(facts.hasErrors, true);
  assert(facts.parseIssues.some(issue => issue.range.start.line === 2));
  assert.deepEqual(facts.functions.map(fn => fn.name), ['visit']);
});

test('project enum navigation works independently of compiler include-path configuration', () => {
  const name = 'BMC_EPDU_COMMAND_POWER_STAT_GET';
  const header = parse('enum bmc_epdu_command_id {\n  '+name+' = 0xf083\n};', 'include/bmc/epdu/bmc_epdu.h');
  const source = '#include <bmc/epdu/bmc_epdu.h>\nint query(void){return '+name+';}';
  const file = parse(source, 'src/epdu/command.c'), index = new CIndex(); index.replace([header, file]);
  const definition = index.definitions(file.uri, { line: 1, character: source.split('\n')[1].indexOf(name) });
  assert.equal(definition[0].uri, header.uri); assert.equal(definition[0].kind, 21); assert.equal(definition[0].selectionRange.start.line, 1);
});
