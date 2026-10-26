'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FileLog } = require('../src/infrastructure/file-log');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
async function fixture(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-file-log-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }

test('file logs preserve order and timestamps, flush on disposal and rotate bounded backups', async t => {
  const directory = await fixture(t), reports = [], log = new FileLog(directory, 'project', value => reports.push(value), { fileBytes: 180, backups: 2 });
  for (let at = 0; at < 12; at++) log.appendLine(`message-${at} 中文`);
  await log.dispose(); log.appendLine('after-close');
  const files = await fs.readdir(directory); assert.equal(files.length, 3);
  const content = (await Promise.all([log.file + '.2', log.file + '.1', log.file].map(file => fs.readFile(file, 'utf8')))).join('');
  assert(content.includes('message-11 中文')); assert(!content.includes('after-close'));
  assert.match(content, /^\d{4}-\d\d-\d\dT/); assert.deepEqual(reports, []);
  const numbers = [...content.matchAll(/message-(\d+)/g)].map(match => Number(match[1]));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  for (const file of files) assert((await fs.stat(path.join(directory, file))).size <= 180);
});

test('log saturation is bounded and records dropped messages; filesystem failure reports once', async t => {
  const directory = await fixture(t), reports = [], log = new FileLog(directory, 'bounded', value => reports.push(value), { queueBytes: 128 });
  for (let at = 0; at < 50; at++) log.appendLine('event-' + at);
  assert(log.queuedBytes <= 128); await log.dispose(); assert.match(await fs.readFile(log.file, 'utf8'), /日志限流/);
  const invalid = path.join(directory, 'not-a-directory'); await fs.writeFile(invalid, 'keep');
  const broken = new FileLog(invalid, 'error', value => reports.push(value));
  broken.appendLine('first'); await broken.flush(); broken.appendLine('second'); await broken.dispose();
  assert.equal(reports.length, 1); assert.match(reports[0], /日志文件写入失败/); assert.equal(await fs.readFile(invalid, 'utf8'), 'keep');
});

test('output mirroring switches directories live, keeps old logs and disables only file logging', async t => {
  const directory = await fixture(t), env = fakeVscode(), output = [];
  env.context.globalStorageUri = env.api.Uri.file(directory);
  env.api.window.createOutputChannel = () => ({ appendLine: line => output.push(line), dispose() {} });
  const { PersistentOutput } = loadWithVscode('../src/infrastructure/persistent-output', env.api);
  const log = new PersistentOutput(env.context); t.after(() => log.dispose());
  const first = log.writer.file; log.appendLine('old-directory');
  env.settings.set('sourceInsightReader.cacheDirectory', path.join(directory, '新的 logs')); log.configure();
  const second = log.writer.file; log.appendLine('new-directory'); await log.flush();
  assert.match(await fs.readFile(first, 'utf8'), /old-directory/); assert(!((await fs.readFile(first, 'utf8')).includes('new-directory')));
  assert.match(await fs.readFile(second, 'utf8'), /new-directory/);
  env.settings.set('sourceInsightReader.fileLoggingEnabled', false); log.configure(); log.appendLine('output-only'); await log.flush();
  assert(output.includes('output-only')); assert(!((await fs.readFile(second, 'utf8')).includes('output-only')));
});

test('one cache root separates same-named workspace projects and places logs beside indexes', async t => {
  const directory = await fixture(t), env = fakeVscode();
  const { databasePath } = require('../src/infrastructure/index-database');
  env.context.globalStorageUri = env.api.Uri.file(directory);
  env.api.workspace.workspaceFolders = ['one/demo', 'two/demo'].map(name => ({ uri: env.api.Uri.file(path.join(directory, name)), name: 'demo' }));
  const { PersistentOutput } = loadWithVscode('../src/infrastructure/persistent-output', env.api);
  const log = new PersistentOutput(env.context); t.after(() => log.dispose());
  assert.equal(log.writers.length, 2); assert.notEqual(log.writers[0].file, log.writers[1].file);
  log.appendLine('workspace-session'); await log.flush();
  for (const [at, folder] of env.api.workspace.workspaceFolders.entries()) {
    const file = log.writers[at].file, database = databasePath(directory, folder.uri.toString());
    assert.equal(path.basename(path.dirname(file)), 'logs'); assert.equal(path.basename(path.dirname(database)), 'indexes');
    assert.equal(path.dirname(path.dirname(file)), path.dirname(path.dirname(database)));
    assert((await fs.readFile(file, 'utf8')).includes('workspace-session'));
  }
});
