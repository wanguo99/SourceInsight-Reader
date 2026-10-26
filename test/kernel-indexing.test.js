'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { identifierAt } = require('../src/infrastructure/identifier-table');
const { cColorSpans } = require('../src/infrastructure/c-color-spans');
let parser;
test.before(async () => { parser = await createParser(); });
test.after(() => parser.delete());
const parse = source => ({ ...parseC(parser, source, 'file:///kernel/main.c', '/kernel/main.c'), project: 'file:///kernel' });
const point = (source, needle, last = false) => {
  const offset = last ? source.lastIndexOf(needle) : source.indexOf(needle);
  assert(offset >= 0);
  return { line: source.slice(0, offset).split('\n').length - 1, character: offset - source.lastIndexOf('\n', offset - 1) - 1 };
};

test('project include tree wins over tool copies without borrowing another project', () => {
  const root = '/kernel', project = 'file:///kernel';
  const sources = {
    'main.c': '#include <linux/types.h>\nbase_t result;',
    'include/linux/types.h': 'typedef int base_t;',
    'tools/include/linux/types.h': 'typedef long base_t;'
  };
  const facts = Object.entries(sources).map(([name, source]) => ({ ...parseC(parser, source, project + '/' + name, root + '/' + name), project }));
  facts.push({ ...parseC(parser, 'typedef char base_t;', 'file:///sdk/include/linux/types.h', '/sdk/include/linux/types.h'), project: 'file:///sdk' });
  const index = new CIndex(); index.replace(facts);
  assert.deepEqual(index.definitions(facts[0].uri, point(sources['main.c'], 'base_t')).map(node => node.uri), [project + '/include/linux/types.h']);
});

test('trailing kernel annotations keep static locals, globals and array definitions', () => {
  const source = '#define __initdata\n#define __read_mostly\n' +
    'unsigned long guard __read_mostly;\nvoid run(void) { static int done __initdata; static char buffer[8] __initdata; done = 1; buffer[0] = 0; }\n';
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  assert(facts.symbols.some(node => node.name === 'guard'));
  assert(!facts.symbols.some(node => node.name === '__read_mostly' && node.category !== 'macro'));
  for (const name of ['done', 'buffer']) {
    const expected = facts.locals.find(node => node.name === name); assert(expected, name);
    assert.deepEqual(index.definitions(facts.uri, point(source, name, true))[0].selectionRange, expected.selectionRange);
  }
  assert.equal(index.definitions(facts.uri, point(source, '__initdata', true))[0].category, 'macro');
});

test('kernel iterator macros do not turn expression arguments into parameter declarations', () => {
  const source = 'int process_counts;\nint sum(void) { int cpu; int total = 0;\nfor_each_possible_cpu(cpu)\n total += per_cpu(process_counts, cpu);\nreturn total; }';
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  assert.equal(identifierAt(facts, point(source, 'process_counts', true)).namespace, 'value');
  assert.equal(index.definitions(facts.uri, point(source, 'process_counts', true))[0].selectionRange.start.line, 0);
  assert(!facts.locals.some(node => node.name === 'process_counts'));
});

test('syscall declaration macros retain typed parameter scope and original macro navigation', () => {
  const source = '#define SYSCALL_DEFINE2(name, type1, arg1, type2, arg2)\n' +
    'SYSCALL_DEFINE2(read_pair, int __user *, tidptr, unsigned int, flags)\n{ return *tidptr + flags; }';
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  for (const name of ['tidptr', 'flags']) assert.equal(index.definitions(facts.uri, point(source, name, true))[0]?.selectionRange.start.line, 1, name);
  assert.equal(index.definitions(facts.uri, point(source, 'SYSCALL_DEFINE2', true))[0]?.category, 'macro');
});

test('goto labels use function scope and a namespace separate from variables', () => {
  const source = 'int run(void) { int out = 1; goto out; out: return out; }\n' +
    'int other(void) { goto out; out: return 0; }';
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  const firstGoto = point(source, 'goto out'); firstGoto.character += 5;
  const secondGoto = point(source, 'goto out', true); secondGoto.character += 5;
  for (const [line, position] of [[0, firstGoto], [1, secondGoto]]) {
    const targets = index.definitions(facts.uri, position);
    assert.equal(targets.length, 1); assert.equal(targets[0].category, 'label'); assert.equal(targets[0].selectionRange.start.line, line);
  }
  const value = point(source, 'return out'); value.character += 7;
  assert.equal(index.definitions(facts.uri, value)[0].kind, 12);
});

test('kernel typedefs parsed as primitive types and legacy boolean enumerators remain navigable', () => {
  const source = 'typedef _Bool bool; typedef unsigned long size_t; typedef long ssize_t;\n' +
    'enum { false = 0, true = 1 };\nbool read(size_t count, ssize_t offset) { return count ? true : false; }';
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  for (const [name, usage] of Object.entries({ bool: 'bool read', size_t: 'size_t count', ssize_t: 'ssize_t offset', true: 'true :', false: 'false;' })) {
    const targets = index.definitions(facts.uri, point(source, usage, true));
    assert.equal(targets.length, 1, name); assert.equal(targets[0].name, name);
    assert.equal(targets[0].selectionRange.start.line, ['true', 'false'].includes(name) ? 1 : 0);
  }
  assert(!facts.symbols.some(node => ['long', '_Bool', 'unsigned'].includes(node.name)));
});

test('C macro bodies containing class comparisons do not mark a C header as C++', () => {
  const source = '#define for_class_range(class, from, to) \\\n  for (class = from; class < to; class++)\ntypedef int visitor;\n';
  const facts = parse(source);
  assert(facts.symbols.some(node => node.name === 'visitor' && node.kind === 25));
});

test('randomized anonymous layouts retain fields and macros in type positions remain candidates', () => {
  const source = '#define __randomize_layout\n#define DECLARE_COMPLETION(name) struct completion name\n' +
    'struct Memory { struct { int rss_stat; int exe_file; } __randomize_layout; };\n' +
    'static DECLARE_COMPLETION(done);\nint read(struct Memory *mm) { return mm->rss_stat; }';
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  assert.equal(index.definitions(facts.uri, point(source, 'rss_stat', true))[0]?.kind, 7);
  assert.equal(index.definitions(facts.uri, point(source, 'DECLARE_COMPLETION', true))[0]?.category, 'macro');
});

test('kernel annotation chains retain real function names, signatures and static binding', () => {
  const source = 'static noinline void __ref __noreturn rest_init(void) { int pid = 1; consume(pid); }\n' +
    'asmlinkage __visible void __sched schedule(void) { rest_init(); }';
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  assert.deepEqual(facts.functions.map(fn => fn.name), ['rest_init', 'schedule']);
  assert.equal(facts.functions[0].static, true);
  assert.equal(facts.functions[0].declaredType.name, 'void');
  assert.deepEqual(facts.locals.map(node => node.name), ['pid']);
  assert.deepEqual(facts.calls.map(node => node.name), ['consume', 'rest_init']);
  assert.equal(index.definitions(facts.uri, point(source, 'rest_init', true))[0].selectionRange.start.line, 0);
});

test('sparse pointer annotations retain field types and preserve macro navigation positions', () => {
  const source = '#define __rcu\nstruct task { int pid; struct task __rcu *parent; };\n' +
    'int read_pid(struct task __rcu *task) { return task->parent->pid; }';
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  assert.equal(facts.hasErrors, false);
  assert.deepEqual(facts.symbols.find(node => node.name === 'task').children.map(node => node.name), ['pid', 'parent']);
  assert.equal(index.definitions(facts.uri, point(source, 'pid', true))[0].selectionRange.start.character, source.split('\n')[1].indexOf('pid'));
  const position = point(source, '__rcu', true);
  assert.equal(identifierAt(facts, position).name, '__rcu');
  assert.equal(index.definitions(facts.uri, position)[0].selectionRange.start.line, 0);
});

test('annotation normalization preserves ordinary identifiers, strings, comments and macro definitions', () => {
  const source = '#define VALUE noinline\n' +
    'typedef int noinline;\nnoinline kept;\nint __init;\nint __rcu(void) { return __init; }\n' +
    'char *text="__sched schedule"; /* __visible item */';
  const facts = parse(source);
  assert(facts.symbols.some(node => node.name === 'noinline' && node.category === 'typedef'));
  assert(facts.symbols.some(node => node.name === 'kept' && node.declaredType.name === 'noinline'));
  assert(facts.symbols.some(node => node.name === '__init'));
  assert(facts.functions.some(node => node.name === '__rcu'));
  assert.equal(facts.symbols.find(node => node.name === 'VALUE').category, 'macro');
});

test('typed per-CPU declarations retain their original names, array shapes and macro occurrences', () => {
  const source = '#define DEFINE_PER_CPU(type, name) type name\n' +
    'static DEFINE_PER_CPU(unsigned long, process_counts) = 0;\n' +
    'DECLARE_PER_CPU(struct task *, current_task);\n' +
    'DEFINE_PER_CPU_SHARED_ALIGNED(int, counts[4]);\n' +
    'unsigned long read_counts(void) { return process_counts; }';
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  for (const name of ['process_counts', 'current_task', 'counts']) assert(facts.symbols.some(node => node.name === name), name);
  assert.equal(facts.symbols.find(node => node.name === 'process_counts').static, true);
  assert.equal(facts.symbols.find(node => node.name === 'current_task').declaredType.name, 'task');
  assert.equal(identifierAt(facts, { line: 1, character: source.split('\n')[1].indexOf('DEFINE_PER_CPU') }).name, 'DEFINE_PER_CPU');
  assert.equal(index.definitions(facts.uri, point(source, 'process_counts', true))[0].selectionRange.start.line, 1);
  assert(!facts.symbols.some(node => !node.name));
});

test('error recovery never exposes empty names or reserved C keywords as declarations', () => {
  for (const source of ['static UNKNOWN_DECL(unsigned long, count) = 0;', 'UNRESOLVED void OTHER schedule(void) { work(); }']) {
    const facts = parse(source);
    assert(!facts.symbols.some(node => !node.name || ['void', 'int'].includes(node.name)));
    assert(!facts.functions.some(node => !node.name || ['void', 'int'].includes(node.name)));
  }
});

test('large directive-only headers keep every macro, continuation, include and undef position', () => {
  const source = ['#include "registers.h"', ...Array.from({ length: 5000 }, (_, at) => `#define REGISTER_${at} ${at}`),
    '#define NEXT(x) \\', '  (REGISTER_4999 + (x))', '#undef REGISTER_0', ''].join('\n');
  const facts = parse(source), index = new CIndex(); index.replace([facts]);
  assert.equal(facts.macros.length, 5001); assert.equal(facts.functions.length, 0); assert.equal(facts.hasErrors, false);
  assert.equal(facts.includes[0].name, 'registers.h'); assert.equal(facts.undefs[0].name, 'REGISTER_0');
  assert.equal(identifierAt(facts, point(source, 'REGISTER_4999', true)).name, 'REGISTER_4999');
  assert.equal(index.definitions(facts.uri, point(source, 'REGISTER_4999', true))[0].selectionRange.start.line, 5000);
});

test('multiline macro bodies and known C++ branches do not become annotation declarations', () => {
  const source = ['#define BODY \\', '  __sched item \\', '  __rcu pointer', '#ifdef __cplusplus', 'class Hidden {};',
    '#else', 'static __init int visible(void){return 1;}', '#endif', ''].join('\n');
  const facts = parse(source);
  assert.deepEqual(facts.functions.map(fn => fn.name), ['visible']);
  assert.equal(facts.symbols.find(node => node.name === 'BODY').category, 'macro');
  assert(!facts.symbols.some(node => ['item', 'pointer', 'Hidden'].includes(node.name)));
});

test('indexing and coloring retain scopes without invoking unsafe native parent traversal', t => {
  const tree = parser.parse('int seed;'), prototype = Object.getPrototypeOf(tree.rootNode); tree.delete();
  t.mock.getter(prototype, 'parent', () => { throw new WebAssembly.RuntimeError('unsafe native parent traversal'); });
  const source = 'struct Item { int value; };\nstatic noinline void __init run(struct Item *item) {\n' +
    'struct Item copy = {.value = 1};\nconsume(item->value + copy.value);\n}\n';
  const facts = parse(source); assert.deepEqual(facts.functions.map(fn => fn.name), ['run']);
  assert.equal(facts.calls[0].name, 'consume'); assert(facts.locals.some(node => node.name === 'item'));
  const spans = cColorSpans(parser, source), column = source.split('\n')[1].indexOf('run');
  assert(spans.some(span => span.line === 1 && span.start === column && span.type === 'function' && span.modifiers.includes('declaration')));
  assert.equal(parse('int next(void){return 1;}').functions[0].name, 'next');
});

test('the independent audit recognizes complete GNU register identifiers in macro replacements', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const { pathToFileURL } = require('node:url'), { execFileSync } = require('node:child_process');
  const { IndexDatabase } = require('../src/infrastructure/index-database');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-register-audit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'registers.h'), output = path.join(directory, 'audit.json'), databaseFile = path.join(directory, 'index.sqlite');
  const source = '#define FLOAT_REG $f0\n#define INT_REG $22\n#define VALUE(n) ((n) + $tmp)\n';
  await fs.writeFile(file, source);
  const facts = { ...parseC(parser, source, pathToFileURL(file).toString(), file), project: pathToFileURL(directory).toString() };
  const database = new IndexDatabase(databaseFile, facts.project, 'test');
  database.publish({ uri: facts.uri, provider: 'local', kind: 'facts', hash: facts.hash, facts }); database.close();
  execFileSync(process.execPath, [path.resolve('scripts/audit-index.js'), '--root', directory, '--database', databaseFile, '--output', output]);
  const result = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(result.macroDefinitions, 3); assert.equal(result.replacementIdentifiers, 5);
  assert.equal(result.missingReplacementOccurrences, 0); assert.deepEqual(result.failures, []);
});
