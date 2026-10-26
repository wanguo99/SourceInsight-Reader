'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const workerThreads = require('node:worker_threads');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

const tick = () => new Promise(resolve => setImmediate(resolve));

function indexFixture(t, fileCount, cpuCount = 12) {
  const os = require('node:os');
  t.mock.method(os, 'availableParallelism', () => cpuCount);
  t.mock.method(os, 'totalmem', () => 32768 * 1048576); t.mock.method(os, 'freemem', () => 16384 * 1048576);
  if (process.availableMemory) t.mock.method(process, 'availableMemory', () => 16384 * 1048576);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fakeVscode(), requests = [], workers = [], owners = new WeakMap(), events = new env.api.EventEmitter();
  let starts = 0, terminations = 0;
  t.mock.method(workerThreads, 'Worker', function() {
    starts++; const worker = new EventEmitter(); workers.push(worker);
    worker.postMessage = message => { requests.push(message); owners.set(message, worker); };
    worker.terminate = () => { terminations++; };
    return worker;
  });
  env.api.workspace.findFiles = async () => [];
  const files = Array.from({ length: fileCount }, (_, i) => env.api.Uri.file(`/project/file-${i}.c`));
  // The facade must budget only supported files that survive catalog filtering.
  const catalog = { list: async () => [...files, env.api.Uri.file('/project/readme.txt')], documents: () => [],
    onDidChange: events.event };
  const { LocalIndex } = loadWithVscode('../src/local-index', env.api);
  const index = new LocalIndex(env.context, catalog);
  t.after(() => { index.worker = undefined; index.dispose(); });
  const complete = (message, result) => owners.get(message).emit('message', { id: message.id, result });
  return { env, files, index, requests, workers, complete, events, starts: () => starts, terminations: () => terminations,
    crash: error => workers.at(-1).emit('error', error),
    online: () => workers.at(-1).emit('online'), progress: () => owners.get(requests[0]).emit('message', { progress: { id: requests[0].id, done: 1, total: fileCount } }),
    snapshot: summary => workers.at(-1).emit('message', { snapshot: { scopeKey: undefined, indexExclude: index.exclude, uris: files.slice(0, 16).map(uri => uri.toString()), summary } }) };
}

test('large initial scans survive the old deadline and concurrent queries reuse the worker', async t => {
  const s = indexFixture(t, 1000);
  const building = s.index.ensure(); await tick();
  assert.equal(s.requests[0].files.length, 1000);
  t.mock.timers.tick(60001); await tick();
  assert.equal(s.index.phase, 'building'); assert.equal(s.terminations(), 0);
  const querying = s.index.symbols(s.files[0]);
  await tick();
  assert.equal(s.starts(), 1); assert.equal(s.requests.length, 1);
  s.complete(s.requests[0], { files: 1000, functions: 1000, calls: 0 });
  assert.equal(await building, true); await tick();
  assert.equal(s.requests[1].action, 'symbols');
  s.complete(s.requests[1], []); assert.deepEqual(await querying, []);
  assert.equal(s.index.phase, 'ready'); assert.equal(s.index.pending.size, 0);
  t.mock.timers.tick(1000000); await tick();
  assert.equal(s.terminations(), 0); assert.equal(s.index.phase, 'ready');
});

test('call graph progress stays visibly distinct from completed file scanning', async t => {
  const s = indexFixture(t, 100), building = s.index.ensure(); await tick();
  const id = s.requests[0].id, worker = s.workers[0];
  worker.emit('message', { progress: { id, stage: 'files', done: 100, total: 100 } });
  assert.match(s.index.status, /100\/100/);
  worker.emit('message', { progress: { id, stage: 'relations', done: 40, total: 100 } });
  assert.match(s.index.status, /调用关系构建中.*40\/100/); assert.equal(s.index.phase, 'building');
  s.complete(s.requests[0], { files: 100, functions: 100, calls: 200 });
  await building; assert.equal(s.index.phase, 'ready');
});

test('budget recovery starts a fresh worker once and reuses committed facts', async t => {
  for (const recovered of [true, false]) await t.test(recovered ? 'transient pressure' : 'persistent pressure', async t => {
    const s = indexFixture(t, 100), building = s.index.ensure(); await tick();
    const partial = { files: 99, functions: 99, calls: 0, memoryLimited: true, deferredFiles: 1,
      database: { engine: 'sqlite', volatileProjects: 0 }, indexedUris: s.files.slice(0, 99).map(uri => uri.toString()) };
    s.complete(s.requests[0], partial); await tick(); await tick();
    assert.equal(s.starts(), 2); assert.equal(s.terminations(), 1); assert.equal(s.requests[1].force, false);
    s.complete(s.requests[1], recovered ? { files: 100, functions: 100, calls: 0 } : partial);
    assert.equal(await building, true); await tick();
    assert.equal(s.starts(), 2); assert.equal(s.index.summary.files, recovered ? 100 : 99);
    assert.equal(Boolean(s.index.summary.memoryLimited), !recovered);
  });
});

test('scan deadlines grow with actual C/H file count and still stop stalled workers', async t => {
  for (const [fileCount, timeout] of [[0, 60000], [2, 62000], [1000, 1060000]]) {
    await t.test(`${fileCount} files`, async t => {
      const s = indexFixture(t, fileCount);
      const building = s.index.ensure();
      const rejected = assert.rejects(building, error => {
        assert.match(error.message, /本地 C 索引扫描超时/);
        assert(error.message.includes(`${fileCount} 个文件`));
        assert(error.message.includes(`${timeout / 1000} 秒`));
        return true;
      });
      await tick();
      t.mock.timers.tick(timeout - 1); await tick();
      assert.equal(s.index.phase, 'building'); assert.equal(s.terminations(), 0);
      t.mock.timers.tick(1); await rejected;
      assert.equal(s.index.phase, 'error'); assert.equal(s.index.ready, undefined);
      assert.equal(s.index.pending.size, 0); assert.equal(s.terminations(), 1);
    });
  }
});

test('refreshes and forced rebuilds recalculate deadlines when the file count changes', async t => {
  const s = indexFixture(t, 1);
  const building = s.index.ensure(); await tick();
  s.complete(s.requests[0], { files: 1, functions: 1, calls: 0 }); await building;
  for (const [force, fileCount] of [[false, 120], [true, 240]]) {
    s.index.catalog.list = async () => Array.from({ length: fileCount }, (_, i) =>
      s.env.api.Uri.file(`/project/file-${i}.h`));
    const refreshing = s.index.refresh(force); await tick();
    const request = s.requests.at(-1);
    assert.equal(request.force, force); assert.equal(request.files.length, fileCount);
    t.mock.timers.tick(60000 + fileCount * 1000 - 1); await tick();
    assert.equal(s.index.phase, 'building'); assert.equal(s.terminations(), force ? 1 : 0);
    s.complete(request, { files: fileCount, functions: fileCount, calls: 0 }); await refreshing;
    t.mock.timers.tick(1); await tick();
    assert.equal(s.index.phase, 'ready'); assert.equal(s.index.pending.size, 0);
  }
  assert.equal(s.starts(), 2);
});

test('ordinary queries retain their timeout during a long scan', async t => {
  const s = indexFixture(t, 1000);
  const building = s.index.ensure(); await tick();
  const querying = s.index.request('workspaceSymbols', { query: 'main' });
  const rejected = assert.rejects(querying, /本地索引查询超时，请刷新 Relation/);
  t.mock.timers.tick(60000); await rejected;
  assert.equal(s.index.phase, 'building'); assert.equal(s.terminations(), 0);
  assert.equal(s.index.pending.size, 1);
  s.complete(s.requests[0], { files: 1000, functions: 1, calls: 0 }); await building;
});

test('extremely large scan deadlines stay within the Node timer limit', async t => {
  const s = indexFixture(t, 0);
  s.index.worker = { postMessage() {} };
  // A sparse array exercises overflow without allocating millions of file objects.
  const scanning = s.index.request('scan', { files: new Array(3000000) });
  const rejected = assert.rejects(scanning, /本地 C 索引扫描超时/);
  t.mock.timers.tick(2147483646); await tick();
  assert.equal(s.index.pending.size, 1);
  t.mock.timers.tick(1); await rejected;
  assert.equal(s.index.pending.size, 0);
});

test('an online worker without progress stops before the file-count hard deadline', async t => {
  const s = indexFixture(t, 1000), building = s.index.ensure();
  const rejected = assert.rejects(building, /60 秒没有文件进度/); await tick(); s.online();
  t.mock.timers.tick(59999); await tick(); s.progress();
  t.mock.timers.tick(59999); await tick(); assert.equal(s.terminations(), 0);
  t.mock.timers.tick(1); await rejected; assert.equal(s.terminations(), 1); assert.equal(s.index.pending.size, 0);
});

test('foreground queries use a committed partial snapshot while explicit ensure waits for completion', async t => {
  const s = indexFixture(t, 1000), building = s.index.ensure(); await tick();
  const foreground = s.index.symbols(s.files[0]); await tick();
  s.snapshot({ files: 16, functions: 16, calls: 0 }); await tick();
  assert.equal(s.requests[1].action, 'symbols'); assert.equal(s.index.getStatus().busy, true);
  s.complete(s.requests[1], []); assert.deepEqual(await foreground, []);
  assert.equal(s.index.pending.size, 1);
  s.complete(s.requests[0], { files: 1000, functions: 1000, calls: 0 }); await building;
  assert.equal(s.index.summary.files, 1000);
});

test('disabling an in-flight index releases its worker and late failures cannot restore the old lifecycle', async t => {
  const s = indexFixture(t, 2), building = s.index.ensure();
  const rejected = assert.rejects(building, /索引已关闭/); await tick();
  s.env.settings.set('sourceInsightReader.indexEnabled', false);
  s.events.fire({ kind: 'config', configuration: { affectsConfiguration: key => key === 'sourceInsightReader.indexEnabled' } });
  await rejected; await tick();
  assert.equal(s.terminations(), 1); assert.equal(s.index.worker, undefined); assert.equal(s.index.pending.size, 0);
  assert.equal(s.index.phase, 'idle'); assert.equal(s.index.getStatus().phase, 'disabled');
});

test('heap exhaustion clears stale facts and blocks automatic worker restart until a manual rebuild', async t => {
  const s = indexFixture(t, 2), building = s.index.ensure();
  const rejected = assert.rejects(building, /memory limit/); await tick();
  s.index.summary = { files: 1, functions: 1, calls: 0 }; s.index.coverage.add(s.files[0].toString());
  s.crash(Object.assign(new Error('Worker terminated due to reaching memory limit: JS heap out of memory'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }));
  await rejected; await tick();
  assert.equal(s.index.summary, undefined); assert.equal(s.index.coverage.size, 0);
  await assert.rejects(s.index.ensure(), /停止自动重试/); assert.equal(s.starts(), 1);
  const rebuilding = s.index.refresh(true); await tick();
  assert.equal(s.starts(), 2); assert.equal(s.requests.at(-1).force, true);
  s.complete(s.requests.at(-1), { files: 2, functions: 2, calls: 0 }); await rebuilding;
  assert.equal(s.index.phase, 'ready'); assert.equal(s.index.memoryFailure, undefined);
});

test('memory-limited scan coverage never claims deferred files are fully indexed', async t => {
  const s = indexFixture(t, 2), building = s.index.ensure(); await tick();
  s.complete(s.requests[0], { files: 1, functions: 1, calls: 0, memoryLimited: true, deferredFiles: 1, indexedUris: [s.files[0].toString()] });
  await building;
  assert.equal(s.index.describe(s.files[0]).state, 'ready');
  assert.equal(s.index.describe(s.files[1]).state, 'notIndexed');
  assert.match(s.index.describe(s.files[1]).note, /内存预算/); assert.match(s.index.status, /结果不完整/);
});

test('an update completed just before a worker replacement cannot republish the old snapshot', async t => {
  const s = indexFixture(t, 1); let complete;
  s.index.updateRequest = () => new Promise(resolve => { complete = resolve; });
  const updating = s.index.updateFile(s.files[0]);
  s.index.stopWorker(new Error('worker replaced'));
  complete({ files: 99, functions: 99, calls: 0 }); await updating;
  assert.equal(s.index.summary, undefined); assert.equal(s.index.coverage.size, 0);
});

test('forced rebuild waits for worker termination and rejects stale snapshots while foreground requests wait for the new index', async t => {
  const s = indexFixture(t, 2), building = s.index.ensure(); await tick();
  s.complete(s.requests[0], { files: 2, functions: 2, calls: 0 }); await building;
  const old = s.index.worker; let finishTermination;
  const terminate = old.terminate;
  old.terminate = () => { terminate(); return new Promise(resolve => { finishTermination = resolve; }); };
  const rebuilding = s.index.refresh(true); await tick();
  assert.equal(s.starts(), 1); assert.equal(s.index.summary, undefined); assert.equal(s.index.coverage.size, 0);
  const repeated = s.index.refresh(true); await tick(); assert.equal(s.starts(), 1);
  let foregroundFinished = false;
  const foreground = s.index.ensure(false, true).then(value => { foregroundFinished = true; return value; });
  await tick(); assert.equal(foregroundFinished, false);
  old.emit('message', { snapshot: { scopeKey: undefined, indexExclude: s.index.exclude, uris: [s.files[0].toString()], summary: { files: 99, functions: 99, calls: 99 } } });
  assert.equal(s.index.summary, undefined);
  finishTermination(); await tick();
  assert.equal(s.starts(), 2); assert.notEqual(s.index.worker, old);
  assert.equal(s.requests.at(-1).force, true);
  assert.equal(foregroundFinished, false);
  s.workers.at(-1).emit('message', { snapshot: { scopeKey: undefined, indexExclude: s.index.exclude,
    uris: [s.files[0].toString()], summary: { files: 1, functions: 1, calls: 0 } } });
  assert.equal(await foreground, true); assert.equal(s.index.getStatus().busy, true);
  s.complete(s.requests.at(-1), { files: 2, functions: 2, calls: 0 });
  await Promise.all([rebuilding, repeated]); assert.equal(await foreground, true); assert.equal(s.index.summary.files, 2);
});

test('closing while a forced rebuild waits for termination cannot create a replacement worker', async t => {
  const s = indexFixture(t, 1), building = s.index.ensure(); await tick();
  s.complete(s.requests[0], { files: 1, functions: 1, calls: 0 }); await building;
  let finishTermination;
  s.index.worker.terminate = () => new Promise(resolve => { finishTermination = resolve; });
  const rebuilding = s.index.refresh(true); await tick();
  s.index.dispose(); finishTermination(); await rebuilding;
  assert.equal(s.starts(), 1); assert.equal(s.index.worker, undefined);
});

test('rapid CPU and memory changes wait for the old worker before allocating new resources', async t => {
  const s = indexFixture(t, 1), building = s.index.ensure(); await tick();
  s.complete(s.requests[0], { files: 1, functions: 1, calls: 0 }); await building;
  let finishTermination; const old = s.index.worker, terminate = old.terminate;
  old.terminate = () => { terminate(); return new Promise(resolve => { finishTermination = resolve; }); };
  s.env.settings.set('sourceInsightReader.indexCpuLimitPercent', 15);
  s.events.fire({ kind: 'config', configuration: { affectsConfiguration: key => key === 'sourceInsightReader.indexCpuLimitPercent' } }); await tick();
  s.env.settings.set('sourceInsightReader.indexMemoryLimitMb', 512);
  s.events.fire({ kind: 'config', configuration: { affectsConfiguration: key => key === 'sourceInsightReader.indexMemoryLimitMb' } }); await tick();
  assert.equal(s.starts(), 1); finishTermination(); await tick(); assert.equal(s.starts(), 2);
  s.complete(s.requests.at(-1), { files: 1, functions: 1, calls: 0 }); await s.index.ready; assert.equal(s.index.phase, 'ready');
});

test('single-core CPU throttling extends the absolute scan deadline', async t => {
  const s = indexFixture(t, 2, 1), building = s.index.ensure(); await tick();
  t.mock.timers.tick(62001); await tick(); assert.equal(s.index.phase, 'building');
  s.complete(s.requests[0], { files: 2, functions: 2, calls: 0 }); await building; assert.equal(s.index.phase, 'ready');
});
