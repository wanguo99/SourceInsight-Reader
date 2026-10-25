'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vscode = require('vscode');

async function run() {
  const root = process.env.SOURCEINSIGHT_READER_INDEX_ROOT, list = process.env.SOURCEINSIGHT_READER_INDEX_FILES;
  assert(root && list, '--index-rebuild requires SOURCEINSIGHT_READER_INDEX_ROOT and SOURCEINSIGHT_READER_INDEX_FILES');
  const files = fs.readFileSync(list, 'utf8').trim().split(/\r?\n/).map(file => vscode.Uri.file(file));
  const contains = uri => {
    const relative = path.relative(root, uri.fsPath);
    return uri.scheme === 'file' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  assert(files.length > 0 && files.every(contains), 'Every input must be inside the read-only source root');
  const extension = vscode.extensions.getExtension('wanguo.wanguo-sourceinsight-reader');
  await extension.activate();
  const { LocalIndex } = require(path.join(extension.extensionPath, 'src/local-index'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-host-index-rebuild-'));
  const cache = path.join(temporary, 'c-index-v2.json');
  if (process.env.SOURCEINSIGHT_READER_INDEX_CACHE) fs.copyFileSync(process.env.SOURCEINSIGHT_READER_INDEX_CACHE, cache);
  const events = new vscode.EventEmitter(), rootUri = vscode.Uri.file(root);
  const catalog = { list: async () => files, documents: () => [], document: () => undefined, scopeKey: () => 'read-only-rebuild',
    roots: () => [{ uri: rootUri }], projectKey: () => rootUri.toString(), contains, accepts: contains, onDidChange: events.event };
  const context = { storageUri: vscode.Uri.file(temporary) };
  const index = new LocalIndex(context, catalog, message => {
    if (message.startsWith('本地 C 索引：') || message.startsWith('{')) console.log(message);
  });
  const runs = []; let completed = false, expected;
  try {
    const selected = files.find(uri => uri.path.endsWith('/executables/nr-uesoftmodem.c')) || files[0];
    index.preferredUri = selected;
    for (let pass = 0; pass < 3; pass++) {
      const before = index.worker, started = Date.now();
      const building = pass ? index.refresh(true) : index.ensure();
      let finished = false; building.then(() => { finished = true; }, () => {});
      assert.equal(await index.ensure(false, true), true);
      const foregroundMs = Date.now() - started, firstSnapshotFiles = index.summary.files;
      if (files.length > 16) assert.equal(finished, false, 'Foreground request waited for the entire scan');
      await building;
      const summary = index.summary;
      expected ??= summary.files;
      assert.equal(summary.files, expected, 'Rebuild lost indexed files');
      assert.equal(summary.memoryLimited, undefined, 'Unexpected memory budget exhaustion');
      assert.equal(index.coverage.size, expected, 'Coverage differs from admitted facts');
      assert(summary.parallel.cpuLimitPercent <= 25, 'Index CPU budget exceeds user limit');
      if (before) { assert.notEqual(index.worker, before); assert.equal(before.threadId, -1); }
      const symbols = await index.symbols(selected);
      assert(symbols.length > 0, 'Representative source is no longer indexed');
      await index.request('flush');
      const memory = await index.request('metrics');
      const result = { phase: pass ? `rebuild-${pass}` : 'initial', passed: true, elapsedMs: Date.now() - started,
        files: summary.files, functions: summary.functions, calls: summary.calls, parseRecoveryFiles: summary.errors,
        threadId: index.worker.threadId, heapUsedMb: memory.heapUsedMb, arrayBuffersMb: memory.arrayBuffersMb,
        limitMb: memory.limitMb, totalMemoryLimitMb: memory.totalLimitMb, managedUsedMb: memory.managedUsedMb,
        rssGrowthMb: memory.rssGrowthMb, parallel: summary.parallel,
        representativeSymbols: symbols.length, foregroundMs, firstSnapshotFiles };
      runs.push(result); console.log(JSON.stringify(result));
    }
    completed = true;
  } finally {
    await index.stopWorker(new Error('host test complete')); index.dispose(); events.dispose();
    fs.writeFileSync(process.env.SOURCEINSIGHT_READER_REPORT, JSON.stringify({ vscode: vscode.version, platform: process.platform,
      extensionVersion: extension.packageJSON.version, installation: process.env.SOURCEINSIGHT_READER_INSTALLATION,
      node: process.versions.node, candidates: files.length, readOnlySource: true, completed, runs, passed: runs.length, skipped: 0 }, null, 2));
  }
}
module.exports = { run };
