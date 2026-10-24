'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { identifierAt, encodeFacts, decodeFacts } = require('../src/infrastructure/identifier-table');
const { IndexMemory } = require('../src/infrastructure/index-memory');
const { JsonIndexRepository } = require('../src/infrastructure/index-repository');

test('packed identifiers retain tag namespaces, receivers and UTF-16 coordinates after a cache round trip', async t => {
  const parser = await createParser(); t.after(() => parser.delete());
  const source = 'struct Record { int value; };\nint read(struct Record *r) { /* 😀 */ return r->value; }';
  const file = parseC(parser, source, 'file:///p/a.c', '/p/a.c');
  assert(file.identifierData instanceof Int32Array); assert(!file.identifiers);
  const restored = decodeFacts(JSON.parse(JSON.stringify(encodeFacts(file))));
  const column = source.split('\n')[1].lastIndexOf('value');
  const token = identifierAt(restored, { line: 1, character: column });
  assert.equal(token.namespace, 'field'); assert(token.receiver); assert.equal(token.name, 'value');
  assert.equal(identifierAt(restored, { line: 1, character: column + 5 }), undefined);
  assert.equal(identifierAt(restored, { line: 0, character: 8 }).type, 'struct_specifier');
  const index = new CIndex(); index.replace([restored]);
  assert.equal(index.definitions(file.uri, { line: 1, character: column })[0].selectionRange.start.line, 0);
});

test('numeric generated tables do not exhaust the fact traversal budget and identifier initializers remain navigable', async t => {
  const parser = await createParser(); t.after(() => parser.delete());
  const source = 'int e;\nint matrix[] = {' + '0x1, -2, 1.25e+3,'.repeat(50000) + '0};\nint values[] = { e, e + 1 };';
  const file = parseC(parser, source, 'file:///p/table.c', '/p/table.c');
  assert(file.symbols.some(value => value.name === 'matrix'));
  assert(file.identifierData.length < 100);
  const index = new CIndex(); index.replace([file]);
  assert.equal(index.definitions(file.uri, { line: 2, character: 17 })[0].name, 'e');
});

test('ambiguous calls store candidate counts without a Cartesian array of all target handles', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
  const base = (name, functions = [], calls = []) => ({ uri: `file:///p/${name}.c`, path: `/p/${name}.c`, project: 'p', functions,
    symbols: [], declarations: [], includes: [], macros: [], calls });
  const definitions = Array.from({ length: 800 }, (_, at) => base('leaf-' + at, [{ id: String(at), name: 'duplicate', uri: `file:///p/leaf-${at}.c`, range, selectionRange: range }]));
  const callers = Array.from({ length: 20 }, (_, at) => base('caller-' + at,
    [{ id: 'caller-' + at, name: 'caller_' + at, uri: `file:///p/caller-${at}.c`, range, selectionRange: range }],
    Array.from({ length: 50 }, () => ({ caller: 'caller-' + at, name: 'duplicate', range }))));
  const index = new CIndex(); index.replace([...definitions, ...callers]);
  const edges = [...index.outgoing.values()].flat(); assert.equal(edges.length, 1000);
  assert.equal(edges.reduce((count, edge) => count + edge.targets.length, 0), 0);
  assert(edges.every(edge => edge.candidateCount === 800 && !edge.resolved));
  assert.equal(index.incoming.size, 0);
  assert.match(index.calls(index.item(callers[0].functions[0]), 'outgoing')[0].to.detail, /多个定义候选/);
});

test('cache loading streams per-file records, filters obsolete roots and retains bounded partial decoding', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-stream-cache-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'facts.json'), repo = new JsonIndexRepository('parser'); await repo.open(file);
  for (let at = 0; at < 80; at++) repo.stage({ uri: `file:///${at}.c`, hash: String(at), functions: [], declarations: [], symbols: [], calls: [], includes: [], macros: [] });
  await repo.flush();
  t.mock.method(fs, 'readFile', async () => { throw new Error('Whole-cache read forbidden'); });
  const filtered = new JsonIndexRepository('parser'); await filtered.open(file, false, { live: new Set(['file:///2.c']) });
  assert.equal(filtered.files.size, 1); assert(filtered.get('file:///2.c'));
  const bounded = new JsonIndexRepository('parser'); await bounded.open(file, false, { canLoad: () => bounded.files.size < 5 });
  assert.equal(bounded.files.size, 5); assert.equal(bounded.loadingLimited, true);
});

test('memory admission reserves graph/parse headroom and reports pressure before the hard heap ceiling', () => {
  let used = 10 * 1048576;
  const memory = new IndexMemory(128, () => ({ heapUsed: used, arrayBuffers: 0 }));
  assert(memory.available()); used = 90 * 1048576; assert(!memory.available()); memory.check();
  used = 110 * 1048576; assert.throws(() => memory.check(), error => error.code === 'INDEX_MEMORY_BUDGET');
});

test('a constrained real Worker keeps a usable explicit partial index instead of crashing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-small-heap-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const worker = new Worker(path.join(__dirname, '../src/index-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 128 }, workerData: { memoryLimitMb: 128 } });
  t.after(() => worker.terminate());
  let sequence = 0; const pending = new Map();
  worker.on('message', message => { const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); });
  worker.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  const request = (action, data) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('memory regression timeout')); }, 20000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...data });
  });
  const text = Array.from({ length: 250 }, (_, at) => `int function_${at}(int arg) { int local = arg; return local; }`).join('\n');
  const files = Array.from({ length: 180 }, (_, at) => ({ uri: `file:///p/f${at}.c`, path: `/p/f${at}.c`, project: 'p', text }));
  const result = await request('scan', { files, cachePath: path.join(dir, 'facts.json') });
  assert.equal(result.memoryLimited, true); assert(result.files > 0 && result.files < files.length);
  assert.equal(result.files + result.deferredFiles, files.length); assert.equal(result.indexedUris.length, result.files);
  const definitions = await request('definitions', { uri: files[0].uri, position: { line: 0, character: 5 } });
  assert.equal(definitions.length, 1); assert.equal(definitions[0].name, 'function_0');
});

test('large legacy single-line caches are discarded before whole-document parsing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-legacy-cache-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'facts.json'), reports = [];
  const handle = await fs.open(file, 'w'); await handle.write('{"version":2,"parser":"parser","files":['); await handle.truncate(20 * 1024 * 1024); await handle.close();
  const repo = new JsonIndexRepository('parser', error => reports.push(error.message)); await repo.open(file);
  assert.equal(repo.files.size, 0); assert(reports.some(message => message.includes('过大')));
});
