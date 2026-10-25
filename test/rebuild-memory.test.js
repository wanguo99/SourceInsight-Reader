'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const threads = require('node:worker_threads');
const { once } = require('node:events');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('cache flush followed by repeated rebuilds cannot inherit the previous worker heap pressure', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-rebuild-pressure-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const shim = path.join(directory, 'pressure-worker.cjs');
  // Reproduce uncollected occupancy deterministically: a second forced scan in
  // one isolate sees the old high heap. A new isolate has no previous objects.
  await fs.writeFile(shim, `const { parentPort, workerData } = require('node:worker_threads');
    const usage = process.memoryUsage; let scans = 0, oldHeap = false;
    parentPort.on('message', message => { if (message.action === 'scan') { oldHeap = Boolean(scans++ && message.force); } });
    process.memoryUsage = () => { const value = usage(); return { ...value, heapUsed: value.heapUsed + (oldHeap ? 1024 * 1048576 : 0) }; };
    process.memoryUsage.rss = usage.rss;
    require(workerData.indexWorker);
  `);
  const RealWorker = threads.Worker, workers = [];
  t.mock.method(threads, 'Worker', function(filename, options) {
    const worker = new RealWorker(shim, { ...options, workerData: { ...options.workerData, indexWorker: filename } });
    workers.push(worker); return worker;
  });
  const env = fakeVscode(), uri = env.api.Uri.file(directory), events = new env.api.EventEmitter();
  const files = ['a.c', 'b.c'].map(name => env.api.Uri.joinPath(uri, name));
  await fs.writeFile(files[0].fsPath, 'int first(void) { return 1; }');
  await fs.writeFile(files[1].fsPath, 'int second(void) { return 2; }');
  env.api.workspace.findFiles = async () => files;
  env.settings.set('sourceInsightReader.indexMemoryLimitMb', 512);
  const context = { ...env.context, storageUri: env.api.Uri.joinPath(uri, 'cache') };
  const catalog = { list: async () => files, documents: () => [], scopeKey: () => 'test', contains: () => true,
    projectKey: () => uri.toString(), onDidChange: events.event };
  const { LocalIndex } = loadWithVscode('../src/local-index', env.api), index = new LocalIndex(context, catalog);
  t.after(async () => { await index.stopWorker(new Error('test complete')); index.dispose(); });
  await index.ensure();
  await index.request('flush');
  // The old same-isolate operation reproduces the empty partial result under
  // the controlled old-heap condition; the public rebuild must recover it.
  await index.scan(true);
  assert.equal(index.summary.files, 0); assert.equal(index.summary.memoryLimited, true);
  assert.equal(index.summary.deferredFiles, files.length);
  for (let pass = 0; pass < 3; pass++) {
    await index.request('flush'); const previous = index.worker, threadId = previous.threadId;
    // A cache write interrupted during rebuild may leave this exact temp path.
    const temporary = path.join(context.storageUri.fsPath, `c-index-v2.json.${process.pid}.${threadId}.tmp`);
    await fs.writeFile(temporary, 'incomplete');
    const exited = once(previous, 'exit');
    await index.refresh(true); await exited;
    assert.notEqual(index.worker, previous); assert.equal(previous.threadId, -1);
    assert.equal(index.summary.files, 2); assert.equal(index.summary.memoryLimited, undefined);
    assert.equal(index.coverage.size, 2);
    assert.equal((await index.symbols(files[1]))[0].name, 'second');
    await assert.rejects(fs.stat(temporary), error => error.code === 'ENOENT');
  }
  assert.equal(workers.length, 4);
});
