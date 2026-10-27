'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { ProjectIndexLock, requestUpdate, pendingUpdates } = require('../src/infrastructure/project-index-lock');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-shared-'));
  const children = [];
  t.after(async () => { await Promise.all(children.map(async child => { if (child.exitCode !== null || child.signalCode) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; })); await fs.rm(root, { recursive: true, force: true }); });
  const file = { uri: pathToFileURL(path.join(root, 'main.c')).toString(), path: path.join(root, 'main.c'), project: pathToFileURL(root).toString() };
  await fs.writeFile(file.path, 'int original(void) { return 1; }');
  const scan = { action: 'scan', files: [file], databaseDirectory: path.join(root, 'cache') };
  function start() {
    const child = fork(path.join(__dirname, 'fixtures/shared-index-process.js'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); children.push(child);
    let sequence = 0; const pending = new Map();
    child.on('message', message => {
      if (!('result' in message || 'error' in message)) return;
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    });
    return { child, request: data => new Promise((resolve, reject) => { const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('child request timeout: ' + data.action)); }, 20000);
      pending.set(id, { resolve, reject, timer }); child.send({ id, ...data }); }) };
  }
  return { root, file, scan, start };
}

test('two processes share one indexing owner, merge saved updates and isolate unsaved buffers', async t => {
  const f = await fixture(t), owner = f.start(), reader = f.start();
  const first = await owner.request(f.scan); assert.equal(first.parsedFiles, 1);
  const second = await reader.request({ ...f.scan, force: true });
  assert.equal(second.database.sharedProjects, 1); assert.equal(second.parsedFiles, 0); assert.equal(second.files, 1);
  assert.equal((await reader.request({ action: 'symbols', uri: f.file.uri }))[0].name, 'original');
  await reader.request({ action: 'update', file: { ...f.file, text: 'int unsaved(void) { return 2; }' }, dirty: true });
  assert.equal((await reader.request({ action: 'symbols', uri: f.file.uri }))[0].name, 'unsaved');
  assert.equal((await owner.request({ action: 'symbols', uri: f.file.uri }))[0].name, 'original');
  await fs.writeFile(f.file.path, 'int changed(void) { return 3; }');
  await reader.request({ action: 'update', file: f.file, dirty: false });
  await owner.request({ action: 'sharedPoll' });
  assert.equal((await reader.request({ action: 'sharedPoll' })).refresh, true);
  await reader.request(f.scan);
  assert.equal((await reader.request({ action: 'symbols', uri: f.file.uri }))[0].name, 'changed');
  assert.equal((await owner.request({ action: 'symbols', uri: f.file.uri }))[0].name, 'changed');
  const exit = once(owner.child, 'exit'); owner.child.kill('SIGKILL'); await exit;
  assert.equal((await reader.request({ action: 'sharedPoll' })).refresh, true);
  const promoted = await reader.request(f.scan); assert.equal(promoted.database.sharedProjects, 0);
  await fs.writeFile(f.file.path, 'int after_crash(void) { return 4; }');
  await reader.request({ action: 'update', file: f.file });
  assert.equal((await reader.request({ action: 'symbols', uri: f.file.uri }))[0].name, 'after_crash');
});

test('project lock cannot be stolen while owner is alive; retained lock file can be reused', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-lock-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'index.sqlite'), first = new ProjectIndexLock(file), second = new ProjectIndexLock(file);
  t.after(() => { first.close(); second.close(); });
  assert.equal(first.acquire(), true); assert.equal(second.acquire(), false);
  requestUpdate(file, 'file:///a.c'); requestUpdate(file, 'file:///a.c'); requestUpdate(file, 'file:///b.c');
  assert.deepEqual(new Set(pendingUpdates(file)), new Set(['file:///a.c', 'file:///b.c'])); assert.deepEqual(pendingUpdates(file), []);
  first.close(); assert.equal(second.acquire(), true); second.close();
  assert.equal((await fs.stat(file + '.writer-lock')).isFile(), true);
});

test('simultaneous cold starts elect one writer and the follower reloads its completed graph', async t => {
  const f = await fixture(t), a = f.start(), b = f.start();
  await fs.writeFile(f.file.path, 'int leaf(void){return 0;} int run(void){return leaf();}');
  const results = await Promise.all([a.request(f.scan), b.request(f.scan)]);
  assert.deepEqual(results.map(result => result.database.sharedProjects).sort(), [0, 1]);
  assert.equal(results.reduce((sum, result) => sum + result.parsedFiles, 0), 1);
  const reader = results[0].database.sharedProjects ? a : b;
  const warm = await reader.request(f.scan);
  assert.equal(warm.parsedFiles, 0); assert.equal(warm.calls, 1);
});
