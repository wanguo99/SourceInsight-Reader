'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CIndex } = require('../src/c-index');
const { highlightDocumentAsync } = require('../src/syntax');
const { TextSearchEngine } = require('../src/infrastructure/text-search-engine');
const { JsonIndexRepository } = require('../src/infrastructure/index-repository');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('deep include queries retain bounded closure storage and preserve reachability', () => {
  const count = 2000, index = new CIndex();
  const files = Array.from({ length: count }, (_, at) => ({ uri: `file:///p/f${at}.h`, path: `/p/f${at}.h`, project: 'p',
    functions: [], symbols: [], declarations: [], macros: [], includes: at + 1 < count ? [{ name: `f${at + 1}.h`, quoted: true }] : [],
    calls: [{ name: 'unknown', caller: 'test', indirect: false, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] }));
  index.replace(files);
  for (let at = 0; at < count; at += 13) assert(index.visible(files[at].uri).has(files.at(-1).uri));
  assert(index.closureEntries <= index.maxClosureEntries); assert(index.closures.size <= 64);
  assert.equal(index.dependentsOf(files.at(-1).uri).size, count - 1);
});

test('cold syntax work yields before walking a long file and cancels replaced snapshots', async () => {
  let visited = 0, cancelled = false;
  const doc = { version: 1, languageId: 'c', lineAt() { visited++; return { text: 'int value = 1;' }; } };
  const work = highlightDocumentAsync(doc, 99960, 99999, () => cancelled);
  assert(visited <= 128, 'the first turn must be bounded');
  cancelled = true; assert.deepEqual(await work, []); assert(visited <= 128);
  const complete = await highlightDocumentAsync(doc, 1000, 1001);
  assert.equal(complete.length, 2); assert.equal(complete[0].map(token => token.text).join(''), 'int value = 1;');
});

test('search Worker avoids repeating full source lines and supports cancellation/restart', async t => {
  const engine = new TextSearchEngine(); t.after(() => engine.dispose());
  const rows = await engine.match('😀 value value', 'value', {}, 10);
  assert.equal(rows[0].start, 3); assert.equal(rows.length, 2); assert.equal('lineText' in rows[0], false);
  const pending = engine.match('x'.repeat(100000), 'x', {}, 100);
  const cancelled = assert.rejects(pending, /取消/); engine.cancel(); await cancelled;
  assert.equal((await engine.match('new', 'new', {}, 10)).length, 1);
});

test('search Worker has a hard computation deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = new TextSearchEngine({ timeout: 100 }); t.after(() => engine.dispose());
  const pending = engine.match('value', 'value', {}, 1), rejected = assert.rejects(pending, /计算超时/);
  t.mock.timers.tick(100); await rejected;
  assert.equal(engine.pending.size, 0); assert.equal(engine.worker, undefined);
});

test('unchanged facts do not rewrite atomic cache snapshots', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-cache-writes-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'facts.json'), repository = new JsonIndexRepository('test');
  const rename = fs.rename; let writes = 0;
  t.mock.method(fs, 'rename', async (...args) => { writes++; return rename(...args); });
  await repository.open(file);
  const fact = { uri: 'file:///a.c', hash: 'hash', stamp: { size: 1 }, project: 'p', scopeKey: 'private-scope',
    functions: [], symbols: [], declarations: [], calls: [], includes: [], macros: [] };
  repository.stage(fact); await repository.flush(); assert.equal(writes, 1);
  repository.stage({ ...fact, scopeKey: 'other-scope' }); repository.prune(new Set([fact.uri])); await repository.flush();
  assert.equal(writes, 1);
  const stored = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(stored.files[0].scopeKey, undefined);
  const loaded = new JsonIndexRepository('test'); await loaded.open(file); assert.equal(loaded.files.size, 1);
});
