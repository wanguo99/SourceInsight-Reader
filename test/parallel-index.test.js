'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { resourcePlan, CpuBudget, ProcessCpuBudget, SharedMemoryBudget } = require('../src/infrastructure/index-resources');
const { extractionClock } = require('../src/infrastructure/resource-clock');
const { ParserPool } = require('../src/infrastructure/parser-pool');
const { WorkerScheduler } = require('../src/infrastructure/worker-scheduler');
const host = { cpus: 12, physicalMb: 32768, availableMb: 16384 };
const plan = () => resourcePlan({ memoryMb: 1024 }, host);

test('CPU allowance includes the coordinator and never exceeds a quarter of available cores', () => {
  for (const cpus of [1, 2, 3, 4, 8, 12, 16, 32, 96]) {
    const value = resourcePlan({ memoryMb: 8192 }, { ...host, cpus });
    assert((value.parsers + 1) * value.cpuFraction <= cpus / 4);
    assert(value.parsers <= 4); assert(value.coordinatorMb + value.parsers * value.parserMb <= value.memoryMb);
  }
  assert.equal(plan().parsers, 2, '12 cores allow two parsing threads plus one coordinator');
  assert.equal(resourcePlan({ cpuPercent: 100 }, host).cpuPercent, 25);
});

test('memory is shared across workers and tight system headroom reduces concurrency', () => {
  const normal = plan(); assert.equal(normal.memoryMb, 1024); assert.equal(normal.coordinatorMb, 512);
  const constrained = resourcePlan({ memoryMb: 1024 }, { ...host, availableMb: 1536 });
  assert.equal(constrained.memoryMb, 384); assert.equal(constrained.parsers, 0);
  assert.equal(resourcePlan({ memoryMb: 128 }, host).parsers, 0);
  assert.equal(resourcePlan({}, { ...host, availableMb: 100 }).lowMemory, true);
});

test('CPU duty cycling pays actual work and cannot bank a long idle period for a later burst', () => {
  let wall = 0, used = 0;
  const cpu = new CpuBudget(0.25, () => wall, () => used, delay => { wall += delay; });
  wall += 100; used += 100; cpu.check(); assert(used / wall < 0.27); assert(cpu.sleptMs > 250);
  wall += 10000; cpu.check(); const before = cpu.sleptMs;
  wall += 100; used += 100; cpu.check(); assert(cpu.sleptMs - before > 200);
});

test('older runtimes exclude intentional blocking from their event-loop CPU fallback', t => {
  let wall = 0; const original = process.threadCpuUsage;
  process.threadCpuUsage = undefined; t.after(() => { process.threadCpuUsage = original; });
  t.mock.method(performance, 'eventLoopUtilization', () => ({ active: wall, idle: 0, utilization: 1 }));
  const cpu = new CpuBudget(0.25, () => wall, undefined, delay => { wall += delay; });
  wall += 100; cpu.check(); assert(wall > 350 && wall < 500);
});

test('intentional throttling does not consume the parser extraction deadline', t => {
  let wall = 100, suspended = 0; t.mock.method(Date, 'now', () => wall);
  const check = Object.assign(() => {}, { suspendedMs: () => suspended }), now = extractionClock(check), started = now();
  wall += 5100; suspended += 5000; assert.equal(now() - started, 100);
});

test('process CPU backpressure counts helper CPU once across multiple parsing threads', () => {
  let wall = 100, used = 0; const shared = new SharedArrayBuffer(32);
  const first = new ProcessCpuBudget({ cpus: 4, cpuPercent: 25 }, shared, () => wall, () => used);
  const second = new ProcessCpuBudget({ cpus: 4, cpuPercent: 25 }, shared, () => wall, () => used);
  first.delay(); wall += 100; used += 180; const delay = first.delay(); assert(delay >= 90);
  assert.equal(second.delay(), delay, 'shared process usage must not be charged twice'); wall += delay; assert(second.delay() < 1);
});

test('combined worker memory participates in admission even when coordinator memory is low', () => {
  const value = plan(), shared = new SharedArrayBuffer(12), slots = new Int32Array(shared);
  const budget = new SharedMemoryBudget(value, { available: () => true }, shared, 0, process.memoryUsage.rss());
  Atomics.store(slots, 1, 900 * 1024); assert.equal(budget.available(), false);
  Atomics.store(slots, 1, 0); assert.equal(budget.available(), true);
});

test('foreground queries run while a background iterator waits for a parser', async () => {
  const scheduler = new WorkerScheduler(); let release;
  const ready = new Promise(resolve => { release = resolve; });
  const job = scheduler.scan((async function* () { yield { wait: ready }; return 'finished'; })());
  assert.equal(await scheduler.submit(() => 'foreground'), 'foreground'); release(); assert.equal(await job, 'finished');
});

test('real parser threads return transferable facts, cap concurrency and release memory slots', async t => {
  const value = plan(), shared = new SharedArrayBuffer((value.parsers + 1) * 4), pool = new ParserPool(value, shared, process.memoryUsage.rss());
  t.after(() => pool.close());
  const tasks = Array.from({ length: 6 }, (_, at) => pool.parse({ source: `int value_${at};`, uri: `file:///p/${at}.c`, path: `/p/${at}.c`, bytes: 12 }));
  const results = await Promise.all(tasks); assert.equal(pool.peakActive, 2);
  assert(results.every(result => result.identifierData instanceof Int32Array)); assert.equal(results[5].symbols[0].name, 'value_5');
  const workers = pool.workers.map(slot => slot.worker); await pool.close(); assert(workers.every(worker => worker.threadId === -1));
  assert.deepEqual([...new Int32Array(shared)], [0, 0, 0]);
});

test('terminating a parser rejects pending jobs and closes the rest of its group', async t => {
  const value = plan(), pool = new ParserPool(value, new SharedArrayBuffer(12), process.memoryUsage.rss()); t.after(() => pool.close());
  const jobs = Array.from({ length: 6 }, () => pool.parse({ source: 'int value;', uri: 'file:///p/a.c', path: '/p/a.c', bytes: 10 }));
  const settled = Promise.allSettled(jobs); await pool.workers[0].worker.terminate(); await settled; await pool.close();
  assert.equal(pool.disabled, true); assert.equal(pool.workers.length, 0);
});

test('a native parser trap retires its worker and does not poison queued files', async t => {
  const value = { ...plan(), parsers: 1 }, shared = new SharedArrayBuffer(8), reports = [], pool = new ParserPool(value, shared, process.memoryUsage.rss(), message => reports.push(message));
  t.after(() => pool.close());
  const failed = pool.parse({ source: 'int failed;', uri: 'file:///p/failed.c', path: '/p/failed.c', bytes: 11 });
  const observed = assert.rejects(failed, { code: 'INDEX_PARSER_CORRUPT' }), slot = pool.workers[0];
  slot.worker.emit('message', { id: slot.job.id, error: 'synthetic native trap', code: 'INDEX_PARSER_CORRUPT' });
  const queued = pool.parse({ source: 'int kept;', uri: 'file:///p/kept.c', path: '/p/kept.c', bytes: 9 });
  await observed; assert.equal((await queued).symbols[0].name, 'kept');
  assert.equal(slot.worker.threadId, -1); assert.equal(pool.disabled, false); assert.equal(pool.peakActive, 1); assert.equal(reports.length, 1);
  await pool.close(); assert.deepEqual([...new Int32Array(shared)], [0, 0]);
});

async function fixture(t, large = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-parallel-')); const project = pathToFileURL(directory).toString();
  const files = [];
  for (let at = 0; at < 40; at++) {
    const file = path.join(directory, `${at}.c`), source = large && at < 2
      ? Array.from({ length: 3000 }, (_, n) => `int f_${at}_${n}(int x){int local=x;return local;}`).join('\n')
      : `int leaf_${at}(void){return ${at ? 'leaf_0()' : '1'};}`;
    await fs.writeFile(file, source); files.push({ uri: pathToFileURL(file).toString(), path: file, project });
  }
  const workers = [];
  t.after(async () => { for (const worker of workers) await worker.terminate(); await fs.rm(directory, { recursive: true, force: true }); });
  const start = (value, prelude = '') => {
    const entry = path.join(__dirname, '../src/index-worker.js');
    const worker = new Worker(prelude ? prelude + `\nrequire(${JSON.stringify(entry)});` : entry, { eval: Boolean(prelude), resourceLimits: { maxOldGenerationSizeMb: value.coordinatorMb }, workerData: { resourcePlan: value } }); workers.push(worker);
    let sequence = 0; const pending = new Map();
    worker.on('message', message => { const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); });
    worker.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
    const request = (action, data = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('parallel index timeout')); }, 20000); pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...data }); });
    return { request, worker };
  };
  return { directory, files, start };
}

test('parallel and serial scans produce identical definitions, references, symbols and calls', async t => {
  const f = await fixture(t), outputs = [];
  for (const value of [resourcePlan({ memoryMb: 1024 }, { ...host, cpus: 4 }), plan()]) {
    const { request } = f.start(value), summary = await request('scan', { files: f.files, databaseDirectory: path.join(f.directory, 'cache-' + value.parsers) });
    assert.equal(summary.files, 40); assert.deepEqual(summary.failures, []); assert.equal(summary.parallel.peakParsers, value.parsers);
    const root = (await request('prepare', { uri: f.files[1].uri, position: { line: 0, character: 5 } }))[0];
    outputs.push({ symbols: await request('workspaceSymbols', { query: 'leaf' }), calls: await request('calls', { item: root, direction: 'outgoing' }),
      definitions: await request('definitions', { uri: f.files[1].uri, position: { line: 0, character: 24 } }), references: await request('references', { uri: f.files[0].uri, position: { line: 0, character: 5 } }) });
    await request('shutdown');
  }
  assert.deepEqual(outputs[1], outputs[0]);
});

test('foreground edits win over already dispatched background results and dirty facts stay off disk', async t => {
  const f = await fixture(t, true), { request, worker } = f.start(plan());
  const firstProgress = new Promise(resolve => { const listener = message => { if (message.progress) { worker.off('message', listener); resolve(); } }; worker.on('message', listener); });
  let finished = false;
  const scanning = request('scan', { files: f.files, databaseDirectory: path.join(f.directory, 'cache') }).then(value => { finished = true; return value; });
  await firstProgress; await request('metrics'); assert.equal(finished, false);
  await request('update', { file: { ...f.files[0], text: 'int newest(void){return 1;}' }, dirty: true }); await scanning;
  assert.equal((await request('symbols', { uri: f.files[0].uri }))[0].name, 'newest');
  await request('scan', { files: f.files, databaseDirectory: path.join(f.directory, 'cache') });
  assert.equal((await request('symbols', { uri: f.files[0].uri }))[0].name, 'f_0_0'); await request('shutdown');
});

test('parser memory failure frees the pool and retries the file serially', async t => {
  const f = await fixture(t, true), value = { ...plan(), parsers: 1, parserMb: 8, coordinatorMb: 512, memoryMb: 520 };
  const { request } = f.start(value), summary = await request('scan', { files: f.files, databaseDirectory: path.join(f.directory, 'cache') });
  assert.equal(summary.files, 40); assert.deepEqual(summary.failures, []); assert.equal(summary.parallel.parserFallbacks, 1);
  assert.equal((await request('symbols', { uri: f.files[0].uri }))[0].name, 'f_0_0'); await request('shutdown');
});

test('safe occupancy above the cache-trimming watermark still admits files and publishes progress', async t => {
  const f = await fixture(t), { request, worker } = f.start(plan(), `
    const originalUsage = process.memoryUsage;
    process.memoryUsage = () => { const value = originalUsage(); return { ...value, heapUsed: value.heapUsed + 325 * 1048576 }; };
    process.memoryUsage.rss = originalUsage.rss;
  `);
  const snapshots = []; worker.on('message', message => { if (message.snapshot) snapshots.push(message.snapshot); });
  const result = await request('scan', { files: f.files, databaseDirectory: path.join(f.directory, 'cache') });
  assert.equal(result.files, 40); assert.equal(result.memoryLimited, undefined); assert.deepEqual(result.failures, []);
  assert(snapshots.some(snapshot => snapshot.summary.files >= 16 && snapshot.summary.files < 40));
  assert(result.parallel.peakParsers > 0, 'healthy parser threads remain usable below the hard admission limit');
  await request('shutdown');
});

test('bounded metadata loading can reuse and stage the project own facts without reparsing', async t => {
  const f = await fixture(t), { request } = f.start(plan()), cache = path.join(f.directory, 'cache');
  await request('scan', { files: f.files, databaseDirectory: cache }); await request('shutdown');
  const { SqliteIndexRepository } = require('../src/infrastructure/sqlite-index-repository');
  const { PARSER_ID } = require('../src/infrastructure/index-schema'); const repository = new SqliteIndexRepository(cache, PARSER_ID);
  try {
    await repository.open(undefined, false, { descriptors: f.files, canLoad: () => false }); assert.equal(repository.files.size, 0);
    for (const file of f.files) {
      const previous = repository.reusable(file); assert(previous); assert.equal(previous._inherited, undefined);
      repository.stage(repository.bind(previous, file));
    }
    assert.equal(repository.files.size, 40); assert.equal(repository.findSymbols('leaf_39')[0].name, 'leaf_39');
  } finally { repository.close(); }
});

test('a complete warm snapshot survives safe metadata occupancy above half the coordinator budget', async t => {
  const f = await fixture(t), cache = path.join(f.directory, 'cache'), cold = f.start(plan());
  const original = await cold.request('scan', { files: f.files, databaseDirectory: cache }); await cold.request('shutdown');
  const warm = f.start(plan(), `
    const originalUsage = process.memoryUsage;
    process.memoryUsage = () => { const value = originalUsage(); return { ...value, heapUsed: value.heapUsed + 250 * 1048576 }; };
    process.memoryUsage.rss = originalUsage.rss;
  `);
  const snapshots = []; warm.worker.on('message', message => { if (message.snapshot) snapshots.push(message.snapshot); });
  const restored = await warm.request('scan', { files: f.files, databaseDirectory: cache });
  assert.equal(snapshots[0]?.summary.fromDatabase, true); assert.equal(snapshots[0]?.summary.files, 40);
  assert.equal(restored.files, original.files); assert.equal(restored.functions, original.functions); assert.equal(restored.calls, original.calls);
  assert.equal(restored.reusedFiles, 40); assert.equal(restored.parsedFiles, 0); assert.equal(restored.memoryLimited, undefined);
  await warm.request('shutdown');
});

test('temporary memory pressure is retried and a foreground edit wins during that retry', async t => {
  for (const editDuringRetry of [false, true]) await t.test(editDuringRetry ? 'edited file' : 'unchanged file', async t => {
    const f = await fixture(t), resources = path.resolve('src/infrastructure/index-resources.js');
    const prelude = `
      const { parentPort } = require('node:worker_threads');
      const { SharedMemoryBudget } = require(${JSON.stringify(resources)});
      const available = SharedMemoryBudget.prototype.available; let denied = false;
      SharedMemoryBudget.prototype.available = function(...args) {
        if (!denied) { denied = true; return false; }
        return available.apply(this, args);
      };
      const fs = require('node:fs/promises'), read = fs.readFile; let held = false;
      fs.readFile = async function(file, ...args) {
        if (${editDuringRetry} && file === ${JSON.stringify(f.files[0].path)} && !held) {
          held = true;
          await new Promise(resolve => {
            const release = message => { if (message.releaseDeferred) { parentPort.off('message', release); resolve(); } };
            parentPort.on('message', release); parentPort.postMessage({ testDeferredRead: true });
          });
        }
        return read.call(this, file, ...args);
      };
    `;
    const { request, worker } = f.start(plan(), prelude);
    const deferred = new Promise(resolve => worker.on('message', message => { if (message.testDeferredRead) resolve(); }));
    const scanning = request('scan', { files: f.files, databaseDirectory: path.join(f.directory, 'cache') });
    if (editDuringRetry) {
      await deferred;
      await request('update', { file: { ...f.files[0], text: 'int newest(void){return 2;}' }, dirty: true });
      worker.postMessage({ releaseDeferred: true });
    }
    const result = await scanning;
    assert.equal(result.files, 40); assert.deepEqual(result.failures, []); assert.equal(result.memoryLimited, undefined);
    assert.equal((await request('symbols', { uri: f.files[0].uri }))[0].name, editDuringRetry ? 'newest' : 'leaf_0');
    await request('shutdown');
  });
});
