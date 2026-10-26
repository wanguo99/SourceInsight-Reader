'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { IndexDatabase, databasePath } = require('../src/infrastructure/index-database');
const { listCacheFiles, deleteCacheFile, formatBytes } = require('../src/infrastructure/cache-files');
const { acquireCacheLease, withCacheDeletion, releaseWorkerLeases } = require('../src/infrastructure/cache-lease');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const { InheritedIndexCache } = require('../src/infrastructure/inherited-index-cache');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-cache-manager-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = 'file:///workspace/project', file = databasePath(directory, project);
  return { directory, file, project };
}

test('cache inventory reports project labels and exact sizes for database, WAL and SHM files', async t => {
  const f = await fixture(t), database = new IndexDatabase(f.file, f.project, 'test');
  t.after(() => database.close());
  const entries = await listCacheFiles([f.directory, f.directory]);
  assert.equal(entries.length, 1); assert.equal(entries[0].project, f.project); assert.equal(entries[0].inUse, true);
  assert.equal(entries[0].size, entries[0].files.reduce((total, file) => total + file.size, 0));
  for (const item of entries[0].files) assert.equal(item.size, (await fs.stat(item.path)).size);
  assert.equal(formatBytes(1024), '1.0 KiB'); assert.equal(formatBytes(0), '0 B');
});

test('deleting an active database is blocked and the same connection remains usable', async t => {
  const f = await fixture(t), database = new IndexDatabase(f.file, f.project, 'test');
  const [entry] = await listCacheFiles([f.directory]);
  assert.deepEqual(await deleteCacheFile(entry), { inUse: true });
  assert.equal(database.meta('project'), f.project); assert((await fs.stat(f.file)).isFile());
  database.close();
  assert.deepEqual(await deleteCacheFile((await listCacheFiles([f.directory]))[0]), { deleted: true });
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('deletion rechecks a cache acquired after the inventory was displayed', async t => {
  const f = await fixture(t); let database = new IndexDatabase(f.file, f.project, 'test'); database.close();
  const [entry] = await listCacheFiles([f.directory]); assert.equal(entry.inUse, false);
  database = new IndexDatabase(f.file, f.project, 'test'); t.after(() => database.close());
  assert.deepEqual(await deleteCacheFile(entry), { inUse: true }); assert.equal(database.meta('project'), f.project);
});

test('a deletion guard prevents new connections until the selected cache is removed', async t => {
  const f = await fixture(t); const database = new IndexDatabase(f.file, f.project, 'test'); database.close();
  const result = await withCacheDeletion(f.file, async () => {
    assert.throws(() => new IndexDatabase(f.file, f.project, 'test'), { code: 'INDEX_CACHE_DELETING' });
    await fs.unlink(f.file);
  });
  assert.deepEqual(result, { deleted: true });
  const restored = new IndexDatabase(f.file, f.project, 'test'); restored.close();
});

test('cache deletion skips symlinks, preserves unrelated files and rejects forged or replaced targets', async t => {
  const f = await fixture(t); const database = new IndexDatabase(f.file, f.project, 'test'); database.close();
  const unrelated = path.join(path.dirname(f.file), 'notes.json'); await fs.writeFile(unrelated, 'keep');
  const [entry] = await listCacheFiles([f.directory]);
  await assert.rejects(deleteCacheFile({ ...entry, path: unrelated }), /无效/);
  await fs.rename(f.file, f.file + '.old'); await fs.writeFile(f.file, 'replacement');
  await assert.rejects(deleteCacheFile(entry), /改变/);
  await fs.unlink(f.file); await fs.symlink(unrelated, f.file);
  assert.equal((await listCacheFiles([f.directory])).length, 0); assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
});

test('batch cache management deletes selected idle entries and warns about active entries without stopping workers', async t => {
  const f = await fixture(t), active = new IndexDatabase(f.file, f.project, 'test'); t.after(() => active.close());
  const idleFile = databasePath(f.directory, 'file:///workspace/idle'), idle = new IndexDatabase(idleFile, 'file:///workspace/idle', 'test'); idle.close();
  const env = fakeVscode(), warnings = [], infos = []; env.settings.set('sourceInsightReader.indexCacheDirectory', f.directory);
  env.api.window.showQuickPick = async (choices, options) => { assert.equal(options.canPickMany, true); assert(choices.every(item => /[KMGT]?i?B/.test(item.label))); return choices; };
  env.api.window.showWarningMessage = async (message, options, confirm) => { warnings.push(message); return confirm; };
  env.api.window.showInformationMessage = async message => infos.push(message);
  const { manageCache } = loadWithVscode('../src/features/cache-manager', env.api); await manageCache({});
  assert(warnings.some(message => message.includes('禁止删除'))); assert.equal(infos.length, 1);
  assert.equal(active.meta('project'), f.project); await assert.rejects(fs.stat(idleFile), { code: 'ENOENT' });
});

test('canceling cache deletion leaves all selected files intact', async t => {
  const f = await fixture(t), database = new IndexDatabase(f.file, f.project, 'test'); database.close();
  const env = fakeVscode(); env.settings.set('sourceInsightReader.indexCacheDirectory', f.directory);
  env.api.window.showQuickPick = async choices => choices;
  env.api.window.showWarningMessage = async () => undefined;
  const { manageCache } = loadWithVscode('../src/features/cache-manager', env.api); await manageCache({});
  assert((await fs.stat(f.file)).isFile());
});

test('selecting only an in-use cache warns and never offers deletion confirmation', async t => {
  const f = await fixture(t), database = new IndexDatabase(f.file, f.project, 'test'); t.after(() => database.close());
  const env = fakeVscode(), warnings = []; env.settings.set('sourceInsightReader.indexCacheDirectory', f.directory);
  env.api.window.showQuickPick = async choices => [choices[0]];
  env.api.window.showWarningMessage = async (...args) => { warnings.push(args); };
  const { manageCache } = loadWithVscode('../src/features/cache-manager', env.api); await manageCache({});
  assert.equal(warnings.length, 1); assert.match(warnings[0][0], /正在使用，禁止删除/);
  assert.equal(warnings[0][1].modal, true); assert.equal(warnings[0].length, 2);
  assert.equal(database.meta('project'), f.project); assert((await fs.stat(f.file)).isFile());
});

test('a cache acquired after selection is preserved and produces a popup', async t => {
  const f = await fixture(t); let database = new IndexDatabase(f.file, f.project, 'test'); database.close();
  t.after(() => database.close());
  const env = fakeVscode(), warnings = []; env.settings.set('sourceInsightReader.indexCacheDirectory', f.directory);
  env.api.window.showQuickPick = async choices => choices;
  env.api.window.showWarningMessage = async (message, options, confirm) => {
    warnings.push({ message, options });
    if (confirm) { database = new IndexDatabase(f.file, f.project, 'test'); return confirm; }
  };
  const { manageCache } = loadWithVscode('../src/features/cache-manager', env.api); await manageCache({});
  assert(warnings.some(value => value.message.includes('缓存正在使用，禁止删除') && value.options.modal));
  assert.equal(database.meta('project'), f.project); assert((await fs.stat(f.file)).isFile());
});

test('worker termination releases only that worker cache leases', async t => {
  const f = await fixture(t); await fs.mkdir(path.dirname(f.file), { recursive: true });
  const releaseMain = acquireCacheLease(f.file); t.after(releaseMain);
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); require(workerData.module).acquireCacheLease(workerData.file); parentPort.postMessage('ready'); setInterval(()=>{},1000);`,
    { eval: true, workerData: { module: path.resolve('src/infrastructure/cache-lease.js'), file: f.file } });
  await once(worker, 'message'); const owner = worker.threadId; await worker.terminate();
  await releaseWorkerLeases([f.directory], owner);
  const markers = (await fs.readdir(path.dirname(f.file))).filter(name => name.includes('.lease-'));
  assert.equal(markers.length, 1); assert(markers[0].includes(`-${process.pid}-0-`));
});

test('cache leases protect a database opened by another process', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', `const {IndexDatabase}=require(process.argv[1]); const database=new IndexDatabase(process.argv[2],process.argv[3],'test'); process.send('ready'); process.on('message',()=>{database.close();process.exit(0);});`,
    path.resolve('src/infrastructure/index-database.js'), f.file, f.project], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => child.kill()); await once(child, 'message');
  assert.deepEqual(await deleteCacheFile((await listCacheFiles([f.directory]))[0]), { inUse: true });
  const exited = once(child, 'exit'); child.send('close'); await exited;
  assert.deepEqual(await deleteCacheFile((await listCacheFiles([f.directory]))[0]), { deleted: true });
});

test('a read-only inherited cache remains protected until its reader closes', async t => {
  const f = await fixture(t), uri = f.project + '/sub/api.h', child = f.project + '/sub';
  const database = new IndexDatabase(f.file, f.project, 'test');
  database.publish({ uri, hash: 'same', provider: 'local', kind: 'facts', facts: { uri, path: '/workspace/project/sub/api.h', project: f.project, hash: 'same',
    functions: [], declarations: [], symbols: [], locals: [], calls: [], macros: [], includes: [], identifierNames: [], identifierData: new Int32Array() } });
  database.close();
  const inherited = new InheritedIndexCache(f.directory, 'test', () => {}); t.after(() => inherited.close());
  const descriptor = { uri, path: '/workspace/project/sub/api.h', project: child };
  await inherited.discover([descriptor]); assert.equal(inherited.take(descriptor)._inherited, true);
  assert.deepEqual(await deleteCacheFile((await listCacheFiles([f.directory]))[0]), { inUse: true });
  inherited.close(); assert.deepEqual(await deleteCacheFile((await listCacheFiles([f.directory]))[0]), { deleted: true });
});
