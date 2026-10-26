'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('real workspace validation resumes committed files after one exhausted coordinator', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-budget-resume-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source'), cache = path.join(directory, 'cache'), output = path.join(directory, 'report.json'), shim = path.join(directory, 'pressure.cjs');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'first.c'), 'int first(void){return 1;}');
  await fs.writeFile(path.join(root, 'second.c'), 'int second(void){return 2;}');
  await fs.writeFile(shim, `
    const { isMainThread, threadId } = require('node:worker_threads');
    if (!isMainThread && threadId === 1) {
      const { IndexMemory } = require(${JSON.stringify(path.resolve('src/infrastructure/index-memory.js'))});
      const { SqliteIndexRepository } = require(${JSON.stringify(path.resolve('src/infrastructure/sqlite-index-repository.js'))});
      const available = IndexMemory.prototype.available, stage = SqliteIndexRepository.prototype.stage; let blocked = false;
      IndexMemory.prototype.available = function(...args) { return !blocked && available.apply(this, args); };
      SqliteIndexRepository.prototype.stage = function(...args) { const result = stage.apply(this, args); blocked = true; return result; };
    }
  `);
  execFileSync(process.execPath, ['--require', shim, path.resolve('scripts/validate-index-workspace.js'), '--root', root, '--cache', cache, '--output', output], { timeout: 30000 });
  const result = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(result.completed, true); assert.equal(result.summary.files, 2); assert.equal(result.summary.memoryLimited, undefined);
  assert.equal(result.summary.reusedFiles, 1); assert.equal(result.summary.parsedFiles, 1);
  assert.equal(result.attempts.length, 1); assert.equal(result.attempts[0].summary.files, 1);
  assert.equal(result.attempts[0].summary.deferredFiles, 1);
});
