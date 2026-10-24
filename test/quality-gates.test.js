'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runBounded } = require('../scripts/run-bounded');
const { verify } = require('../scripts/verify-package');
const boundary = require('../src/domain/boundary');
const { normalizeLocation, uniqueLocations, normalizeSymbols } = require('../src/core');

test('test process watchdog terminates a hung process instead of leaving a running host', async () => {
  const started = Date.now();
  await assert.rejects(runBounded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 150, stdio: 'ignore' }), error => error.code === 'timeout');
  assert(Date.now() - started < 5000);
  await runBounded(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 5000, stdio: 'ignore' });
});

test('provider and worker boundaries reject malformed positions, reversed ranges and invalid envelopes', () => {
  const good = { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } };
  assert(boundary.range(good));
  for (const value of [null, {}, { start: good.end, end: good.start }, { start: { line: -1, character: 0 }, end: good.end }]) assert(!boundary.range(value));
  assert(!boundary.indexMessage({ progress: { done: 10, total: 2 } }));
  assert(!boundary.indexMessage({ snapshot: { uris: ['not-a-uri'], summary: { files: 1, functions: 1, calls: 0 } } }));
  assert(boundary.indexMessage({ id: 1, result: [] }));
  const values = [null, {}, { uri: 'broken', range: good }, { uri: 'file:///a.c', range: good }].map(normalizeLocation);
  assert.equal(uniqueLocations(values).length, 1);
  assert.deepEqual(normalizeSymbols([null, {}, { name: 'invalid', kind: 11, range: {} }], 'file:///a.c'), []);
});

test('package verification refuses mismatched checksums before trusting archive contents', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-artifact-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tampered.vsix'); await fs.writeFile(file, 'tampered'); await fs.writeFile(file + '.sha256', '0'.repeat(64) + ' tampered.vsix\n');
  await assert.rejects(verify(file), /SHA-256/);
  assert.equal((await fs.readFile(file + '.sha256', 'utf8')).slice(0, 64), '0'.repeat(64));
});

test('capability manifest keeps project writes restricted and advertises virtual workspace limits', () => {
  const manifest = require('../package.json');
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, 'limited');
  assert(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations.includes('sourceInsightReader.autoConfigureClangd'));
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, 'limited'); assert.equal(manifest.browser, undefined);
});

test('index worker acknowledges a clean shutdown before closing its message port', async t => {
  const { Worker } = require('node:worker_threads');
  const worker = new Worker(path.join(__dirname, '../src/index-worker.js')); t.after(() => worker.terminate());
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('shutdown acknowledgement timeout')), 3000);
    worker.on('error', error => { clearTimeout(timer); reject(error); });
    worker.on('message', message => { if (message.id === 1) { clearTimeout(timer); resolve(message); } });
    worker.postMessage({ id: 1, action: 'shutdown' });
  });
  assert.equal(result.id, 1); assert.deepEqual(result.result, {});
});
