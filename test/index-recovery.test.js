'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectIndexIssues } = require('../src/domain/index-diagnostics');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { createParser, parseC } = require('../src/c-parser');
const { cSourceProjection } = require('../src/infrastructure/c-source-projection');
const { decodeSource, isCppHeader } = require('../src/infrastructure/source-text');
const { CIndex } = require('../src/c-index');
const { indexStatus, failureKind } = require('../src/domain/index-diagnostics');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('large C++ inventories cannot hide late budget, large-file or encoding diagnostics', () => {
  const files = Array.from({ length: 6000 }, (_, i) => ({ uri: `file:///p/${i}.hpp`, requiresSemantic: true, symbolCount: 0, functionCount: 0,
    get symbols() { throw new Error('Facts must remain on disk'); } }));
  files.push({ uri: 'file:///p/late.c', symbolCount: 1, functionCount: 0, declarationsOnly: true, warnings: ['comment encoding recovered'] });
  const result = collectIndexIssues(files, new Map([['file:///p/broken.c', 'read failed']]), ['file:///p/budget.c']);
  assert.equal(result.length, 5000); assert.equal(result[0].kind, 'error'); assert.equal(result[1].kind, 'budget');
  assert(result.some(value => value.uri === 'file:///p/late.c' && value.kind === 'limited'));
  assert(result.some(value => value.uri === 'file:///p/late.c' && value.kind === 'warning'));
});
let parser;
test.before(async () => { parser = await createParser(); });
test.after(() => parser.delete());
const parse = (source, file = '/project/api.h', options) => parseC(parser, source, 'file://' + file, file, () => {}, options);

test('C/C++ compatibility headers index their C declarations instead of rejecting the entire file', () => {
  const source = '#ifdef __cplusplus\n#include <atomic>\n#define _Atomic(X) std::atomic<X>\nextern "C" {\n#endif\n' +
    'struct Shared { int field; };\nint api(struct Shared *value);\n#ifdef __cplusplus\n}\n#endif\n';
  assert.equal(isCppHeader(source, '/project/api.h'), false);
  const facts = parse(source);
  assert.equal(facts.hasErrors, false); assert.deepEqual(facts.symbols.map(value => value.name), ['Shared', 'api']);
  assert.equal(facts.symbols[0].selectionRange.start.line, 5);
  assert.equal(facts.symbols[0].children[0].name, 'field');
  assert.throws(() => parse('namespace real { class Box {}; }'), /C\+\+/);
});

test('only known C++ guards choose a branch; unknown build flags and nested C branches remain available', () => {
  const source = '#if defined(__cplusplus) && FEATURE\nclass Bad {};\n#elif !defined(__cplusplus)\n' +
    '#if BUILD_A\nint first(void) { return 1; }\n#else\nint second(void) { return 2; }\n#endif\n' +
    '#else\nclass Bad2 {};\n#endif\n#ifndef __cplusplus\nint c_api;\n#else\nstd::atomic<int> cpp_api;\n#endif\n';
  const facts = parse(source);
  assert.equal(facts.hasErrors, false); assert.deepEqual(facts.functions.map(value => value.name), ['first', 'second']);
  assert(facts.symbols.some(value => value.name === 'c_api'));
  assert(!facts.symbols.some(value => /Bad|cpp_api/.test(value.name)));
});

test('GNU suffix attributes no longer swallow array declarations or their references', () => {
  const source = 'int global[4] __attribute__((aligned(32))) = {0};\n' +
    'int run(void) { int local[4] __attribute__((aligned(64))); local[0] = global[0]; return local[0]; }';
  const facts = parse(source, '/project/a.c'), index = new CIndex(); index.replace([facts]);
  assert.equal(facts.hasErrors, false); assert(facts.symbols.some(value => value.name === 'global'));
  const column = source.split('\n')[1].lastIndexOf('local');
  const definition = index.definitions(facts.uri, { line: 1, character: column });
  assert.equal(definition.length, 1); assert.equal(definition[0].name, 'local');
  assert.equal(definition[0].selectionRange.start.character, source.split('\n')[1].indexOf('local'));
});

test('conditional parameters and initializer entries stay navigable at their original UTF-16 positions', () => {
  const source = 'int run(int first,\n#ifdef EXTRA\nint extra,\n#endif\nint last) { return last; }\n' +
    'int values[] = {\n#if FLAG\n1,\n#else\n2,\n#endif\n3 };\n';
  const projected = cSourceProjection(source), facts = parse(source, '/project/a.c');
  assert.equal(projected.length, source.length); assert.equal(projected.split('\n').length, source.split('\n').length);
  assert.equal(facts.hasErrors, false); assert.equal(facts.functions[0].name, 'run');
  assert.deepEqual(facts.locals.filter(value => value.name === 'extra').map(value => value.selectionRange.start.line), [2]);
  assert(facts.symbols.some(value => value.name === 'values'));
});

test('syntax projection preserves comments, strings, CRLF and astral UTF-16 offsets', () => {
  const source = '/* __attribute__((bad)) 😀 */\r\nconst char *s = "__attribute__((keep))";\r\nint value __attribute__((aligned(16)));';
  const projected = cSourceProjection(source), facts = parse(source, '/project/a.c');
  assert.equal(projected.length, source.length); assert(projected.startsWith(source.split('\r\n').slice(0, 2).join('\r\n')));
  assert.equal(facts.symbols.find(value => value.name === 'value').selectionRange.start.character, 4);
  assert.equal(facts.symbols.find(value => value.name === 'value').selectionRange.start.line, 2);
});

test('invalid UTF-8 bytes exclusively in comments retain editor positions with a warning, never repair names or strings', () => {
  const bytes = Buffer.concat([Buffer.from('/* author\'s '), Buffer.from([0x92]), Buffer.from(' note */\r\nint valid(void) { return 1; }')]);
  const warnings = [], source = decodeSource(bytes, 'utf8', value => warnings.push(value));
  assert.equal(warnings.length, 1); assert.equal(source, new TextDecoder('utf-8').decode(bytes));
  const facts = parse(source, '/project/encoding.c'); assert.equal(facts.functions[0].selectionRange.start.line, 1);
  for (const prefix of ['int bad', 'char *s = "']) assert.throws(() => decodeSource(Buffer.concat([Buffer.from(prefix), Buffer.from([0xff])])), /解码/);
  assert.throws(() => decodeSource(Buffer.from([0, 0, 1])), /NUL/);
});

test('declaration-only parsing retains large-file function signatures and explicitly omits executable call relations', () => {
  const source = 'int leaf(void) { return 1; }\nint run(int parameter) { int local = leaf(); return local; }';
  const facts = parse(source, '/project/large.c', { declarationsOnly: true }), index = new CIndex(); index.replace([facts]);
  assert.equal(facts.declarationsOnly, true); assert.equal(facts.functions.length, 2); assert.equal(facts.calls.length, 0);
  assert(!facts.locals.some(value => value.name === 'local'));
  assert.equal(index.summary().limitedFiles, 1);
  assert.match(index.callDiagnostics(index.item(facts.functions[1]), 'outgoing').join(' '), /函数体和调用关系未索引/);
});

test('index status distinguishes unsupported files, resource limits, recovery and genuine failures', () => {
  const status = indexStatus({ files: 3, functions: 4, calls: 5, errors: 1, warnings: 1, limitedFiles: 1, failures: [
    { message: 'C++ 头文件需要语言服务' }, { message: '文件超过本地索引 16 MiB 硬限制' }, { message: '无法按 utf-8 解码源码' }
  ] });
  assert.match(status, /1 个文件处理失败/); assert.match(status, /1 个 C\+\+ 文件需语言服务/);
  assert.match(status, /1 个文件超预算未收录/); assert.match(status, /已保留可识别符号/); assert.match(status, /仅收录顶层符号/);
  assert(!status.includes('含语法错误')); assert.equal(failureKind('访问被拒绝'), 'error');
});

test('index issue picker opens the selected source location and rechecks project scope', async () => {
  const env = fakeVscode(), document = env.document('a.c', 'int first;\nint second;');
  let allowed = true;
  const { ReaderTools } = loadWithVscode('../src/features/reader-tools', env.api);
  const tools = new ReaderTools({ context: env.context, catalog: { accepts: () => allowed }, localIndex: {
    issues: async () => [{ uri: document.uri.toString(), kind: 'parseRecovery', message: 'incomplete', range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } } }]
  } });
  await tools.indexIssues(); assert.equal(env.api.window.activeTextEditor.document, document);
  assert.equal(env.api.window.activeTextEditor.selection.active.line, 1);
  allowed = false; env.api.window.activeTextEditor = undefined;
  await tools.indexIssues(); assert.equal(env.api.window.activeTextEditor, undefined);
});

test('real Worker indexes large-file top-level symbols, retains C++ outlines and reports comment decoding recovery', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-index-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const worker = new Worker(path.join(__dirname, '../src/index-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 512 }, workerData: { memoryLimitMb: 512 } });
  t.after(() => worker.terminate());
  let sequence = 0; const pending = new Map();
  worker.on('message', message => { const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); });
  worker.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  const request = (action, data = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error('index recovery Worker timeout')), 25000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...data });
  });
  const files = ['large.c', 'shared.h', 'cpp.h', 'encoding.c'].map(name => ({ path: path.join(directory, name), uri: pathToFileURL(path.join(directory, name)).href, project: 'p' }));
  await fs.writeFile(files[0].path, '/*' + ' '.repeat(8 * 1048576) + '*/\nint huge_entry(void) { return helper(); }');
  await fs.writeFile(files[1].path, '#ifdef __cplusplus\n#define _Atomic(X) std::atomic<X>\n#endif\nstruct Shared { int value; };');
  await fs.writeFile(files[2].path, 'namespace cpp { class Real {}; }');
  await fs.writeFile(files[3].path, Buffer.concat([Buffer.from('/* note '), Buffer.from([0x92]), Buffer.from(' */\nint decoded(void) { return 1; }')]));
  const summary = await request('scan', { files });
  assert.equal(summary.files, 4); assert.equal(summary.limitedFiles, 1); assert.equal(summary.warnings, 1);
  assert.equal(summary.failures.length, 0);
  assert((await request('symbols', { uri: files[2].uri })).some(value => value.name === 'cpp'));
  assert((await request('workspaceSymbols', { query: 'huge_entry' })).some(value => value.name === 'huge_entry'));
  assert((await request('symbols', { uri: files[1].uri })).some(value => value.name === 'Shared'));
  const issues = await request('issues'); assert(issues.some(value => value.kind === 'limited'));
  assert(issues.some(value => value.kind === 'warning')); assert(issues.some(value => value.kind === 'outline'));
});


test('struct-only C++ headers route methods and constructors to the C++ outline', async t => {
  const { SourceParser } = require('../src/infrastructure/source-parser');
  const parser = new SourceParser(); t.after(() => parser.close());
  for (const source of ['struct Device { Device(); int read() const; int value; };',
    'struct Device { int read(); };', 'struct Device { ~Device(); };',
    'struct Device : Base { int value; };']) {
    assert.equal(isCppHeader(source, 'device.h'), true, source);
    const facts = await parser.parse({source, path:'/project/device.h', uri:'file:///project/device.h', bytes:source.length}, () => {});
    assert.equal(facts.requiresSemantic, true); assert.equal(facts.hasErrors, false);
    if (source.includes('read')) assert(facts.symbols[0].children.some(value => value.name === 'read' && value.kind === 5));
    if (source.includes('Device();')) assert(facts.symbols[0].children.some(value => /Device/.test(value.name)));
  }
  for (const source of ['struct Device { int (*read)(int); int value; };',
    'struct file_operations { unsigned long (*get_area)(int); long long (*read)(int); };',
    'struct backend { enum protocol (*vendor_protocol)(void *context); };',
    'struct Device { unsigned long value; DECLARE_BITMAP(bits, 32); };',
    'int read(void) { return 1; }', 'struct Device { int value; }; // Device();',
    '#ifdef __cplusplus\nstruct Device { Device(); };\n#endif\nstruct CDevice { int value; };'])
    assert.equal(isCppHeader(source, 'device.h'), false, source);
});
