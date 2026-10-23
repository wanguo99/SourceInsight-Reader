'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const workerThreads = require('node:worker_threads');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

const tick = () => new Promise(resolve => setImmediate(resolve));

function indexFixture(t, fileCount) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = fakeVscode(), requests = [], worker = new EventEmitter();
  let starts = 0, terminations = 0;
  worker.postMessage = message => requests.push(message);
  worker.terminate = () => { terminations++; };
  t.mock.method(workerThreads, 'Worker', function() { starts++; return worker; });
  env.api.workspace.findFiles = async () => [];
  const files = Array.from({ length: fileCount }, (_, i) => env.api.Uri.file(`/project/file-${i}.c`));
  // The facade must budget only supported files that survive catalog filtering.
  const catalog = { list: async () => [...files, env.api.Uri.file('/project/readme.txt')], documents: () => [],
    onDidChange: () => ({ dispose() {} }) };
  const { LocalIndex } = loadWithVscode('../src/local-index', env.api);
  const index = new LocalIndex(env.context, catalog);
  t.after(() => { index.worker = undefined; index.dispose(); });
  const complete = (message, result) => worker.emit('message', { id: message.id, result });
  return { env, files, index, requests, complete, starts: () => starts, terminations: () => terminations };
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
    assert.equal(s.index.phase, 'building'); assert.equal(s.terminations(), 0);
    s.complete(request, { files: fileCount, functions: fileCount, calls: 0 }); await refreshing;
    t.mock.timers.tick(1); await tick();
    assert.equal(s.index.phase, 'ready'); assert.equal(s.index.pending.size, 0);
  }
  assert.equal(s.starts(), 1);
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
