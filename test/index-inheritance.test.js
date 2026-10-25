'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { databasePath } = require('../src/infrastructure/index-database');

async function fixture(t, sources) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-inheritance-'));
  const cache = path.join(root, 'cache'), project = path.join(root, 'project');
  for (const [name, source] of Object.entries(sources)) { const file = path.join(project, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, source); }
  const workers = [], uri = value => pathToFileURL(value).toString();
  t.after(async () => { for (const worker of workers) await worker.terminate(); await fs.rm(root, { recursive: true, force: true }); });
  const start = () => {
    const worker = new Worker(path.join(__dirname, '../src/index-worker.js')); workers.push(worker);
    let sequence = 0; const pending = new Map(), snapshots = [], diagnostics = [];
    worker.on('message', message => {
      if (message.snapshot) snapshots.push(message.snapshot); if (message.diagnostic) diagnostics.push(message.diagnostic);
      const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
    });
    const request = (action, data = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Inheritance worker timeout')); }, 15000);
      pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...data });
    });
    const scan = (folder, names, force = false) => request('scan', { databaseDirectory: cache, force,
      files: names.map(name => ({ uri: uri(path.join(project, name)), path: path.join(project, name), project: uri(path.join(project, folder)) })) });
    return { request, scan, snapshots, diagnostics };
  };
  const database = (folder, readOnly = false) => new DatabaseSync(databasePath(cache, uri(path.join(project, folder))), { readOnly });
  return { root, project, cache, uri, start, database };
}

test('opening a parent reuses child syntax after hashing current files and recomputes parent call bindings', async t => {
  const f = await fixture(t, { 'child/api.h': 'int external(void);', 'child/use.c': '#include "api.h"\nint run(void){return external();}', 'impl.c': 'int external(void){return 1;}' });
  const child = f.start(); await child.scan('child', ['child/api.h', 'child/use.c']); await child.request('shutdown');
  const childDb = f.database('child'); const childRevision = childDb.prepare("SELECT value FROM meta WHERE key='revision'").get().value;
  childDb.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(f.uri(path.join(f.project, 'child/use.c')), 'languageService', 'symbols', '', '', 'hash', 'semantic', 1, Buffer.from('unused')); childDb.close();
  const parent = f.start(), summary = await parent.scan('', ['child/api.h', 'child/use.c', 'impl.c']);
  assert.equal(summary.inheritedFiles, 2); assert.equal(summary.reusedFiles, 2); assert.equal(summary.parsedFiles, 1); assert.equal(summary.files, 3);
  const roots = await parent.request('prepare', { uri: f.uri(path.join(f.project, 'child/use.c')), position: { line: 1, character: 5 } });
  const outgoing = await parent.request('calls', { item: roots[0], direction: 'outgoing' }); assert.equal(outgoing[0].to.uri, f.uri(path.join(f.project, 'impl.c')));
  await parent.request('shutdown');
  const target = f.database('', true), source = f.database('child', true);
  assert.equal(target.prepare('SELECT count(*) AS n FROM snapshots').get().n, 0, 'semantic observations must not be inherited');
  assert.equal(source.prepare("SELECT value FROM meta WHERE key='revision'").get().value, childRevision, 'source cache stays unchanged');
  const decode = bytes => JSON.parse(require('node:zlib').inflateRawSync(bytes));
  for (const row of target.prepare('SELECT metadata FROM files').all()) assert.equal(decode(row.metadata).project, f.uri(f.project));
  source.close(); target.close();
  const warm = f.start(), restored = await warm.scan('', ['child/api.h', 'child/use.c', 'impl.c']);
  assert.equal(restored.inheritedFiles, 0); assert.equal(restored.reusedFiles, 3); assert.equal(restored.parsedFiles, 0); await warm.request('shutdown');
});

test('opening a child reuses parent facts without importing parent-only macros or call targets', async t => {
  const f = await fixture(t, { 'api.h': '#define OUTSIDE 1\nint external(void){return 2;}', 'child/use.c': '#include "../api.h"\nint run(void){return OUTSIDE + external();}' });
  const parent = f.start(); await parent.scan('', ['api.h', 'child/use.c']); await parent.request('shutdown');
  const child = f.start(), summary = await child.scan('child', ['child/use.c']);
  assert.equal(summary.inheritedFiles, 1); assert.equal(summary.parsedFiles, 0); assert.equal(summary.files, 1);
  const uri = f.uri(path.join(f.project, 'child/use.c'));
  assert.deepEqual(await child.request('definitions', { uri, position: { line: 1, character: 21 } }), []);
  const roots = await child.request('prepare', { uri, position: { line: 1, character: 5 } });
  assert((await child.request('calls', { item: roots[0], direction: 'outgoing' }))[0].to.sourceInsightReaderLocal.unresolved);
  assert.deepEqual(await child.request('workspaceSymbols', { query: 'OUTSIDE' }), []); await child.request('shutdown');
});

test('modified, deleted, excluded and new files are reconciled against the current enumeration', async t => {
  const f = await fixture(t, { 'child/keep.c': 'int kept;', 'child/edit.c': 'int old_name;', 'child/deleted.c': 'int removed;', 'child/excluded.c': 'int hidden;' });
  const child = f.start(); await child.scan('child', ['child/keep.c', 'child/edit.c', 'child/deleted.c', 'child/excluded.c']); await child.request('shutdown');
  await fs.writeFile(path.join(f.project, 'child/edit.c'), 'int new_name;'); await fs.unlink(path.join(f.project, 'child/deleted.c'));
  await fs.writeFile(path.join(f.project, 'added.c'), 'int added;');
  const parent = f.start(), summary = await parent.scan('', ['child/keep.c', 'child/edit.c', 'added.c']);
  assert.equal(summary.inheritedFiles, 1); assert.equal(summary.parsedFiles, 2); assert.equal(summary.files, 3);
  for (const query of ['old_name', 'removed', 'hidden']) assert.deepEqual(await parent.request('workspaceSymbols', { query }), []);
  assert.equal((await parent.request('workspaceSymbols', { query: 'new_name' }))[0].name, 'new_name'); await parent.request('shutdown');
});

test('inheritance checks source hashes even when cached filesystem stamps appear current', async t => {
  const f = await fixture(t, { 'child/a.c': 'int old_name;' }); const child = f.start(); await child.scan('child', ['child/a.c']); await child.request('shutdown');
  const file = path.join(f.project, 'child/a.c'); await fs.writeFile(file, 'int new_name;'); const info = await fs.stat(file);
  const database = f.database('child'); database.prepare('UPDATE files SET stamp=?').run(JSON.stringify({ size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, inode: String(info.ino), encoding: 'utf8' })); database.close();
  const parent = f.start(), summary = await parent.scan('', ['child/a.c']); assert.equal(summary.inheritedFiles, 0); assert.equal(summary.parsedFiles, 1);
  assert.equal((await parent.request('symbols', { uri: f.uri(file) }))[0].name, 'new_name'); await parent.request('shutdown');
});

for (const mode of ['bad-facts', 'old-parser', 'future-schema', 'unrelated', 'force']) test(`optional inherited caches fall back safely: ${mode}`, async t => {
  const f = await fixture(t, { 'child/a.c': 'int intact;' }); const child = f.start(); await child.scan('child', ['child/a.c']); await child.request('shutdown');
  const database = f.database('child');
  if (mode === 'bad-facts') database.prepare('UPDATE files SET facts=?').run(Buffer.from('invalid'));
  if (mode === 'old-parser') database.prepare("UPDATE meta SET value='old-parser' WHERE key='parser'").run();
  if (mode === 'future-schema') database.exec('PRAGMA user_version=999');
  if (mode === 'unrelated') database.prepare("UPDATE meta SET value='file:///unrelated' WHERE key='project'").run();
  database.close();
  const parent = f.start(), summary = await parent.scan('', ['child/a.c'], mode === 'force');
  assert.equal(summary.inheritedFiles, 0); assert.equal(summary.parsedFiles, 1); assert.deepEqual(summary.failures, []);
  assert.equal((await parent.request('symbols', { uri: f.uri(path.join(f.project, 'child/a.c')) }))[0].name, 'intact'); await parent.request('shutdown');
  if (mode === 'future-schema') { const source = f.database('child', true); assert.equal(source.prepare('PRAGMA user_version').get().user_version, 999); source.close(); }
});

test('inherited scans publish validated first-batch results before completing the project', async t => {
  const sources = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`child/${i}.c`, `int value_${i};`]));
  const f = await fixture(t, sources), names = Object.keys(sources), child = f.start(); await child.scan('child', names); await child.request('shutdown');
  const parent = f.start(), summary = await parent.scan('', names);
  assert.equal(summary.inheritedFiles, 48); assert.equal(summary.parsedFiles, 0);
  assert(parent.snapshots.some(snapshot => snapshot.summary.files === 16 && snapshot.summary.inheritedFiles === 16));
  await parent.request('shutdown');
});
