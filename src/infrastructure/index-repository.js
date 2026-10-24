'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { threadId } = require('node:worker_threads');
// Persistence port. Replacing this implementation does not affect the parser,
// graph resolver or query protocol.
class JsonIndexRepository {
  constructor(parserId, report = error => {}) { this.parserId = parserId; this.report = report; this.files = new Map(); this.writes = Promise.resolve(); this.dirty = false; }
  async open(file, force = false) {
    this.path = file;
    if (force) { this.files.clear(); return; }
    if (this.files.size || !file) return;
    try {
      const stored = JSON.parse(await fs.readFile(file, 'utf8'));
      if (stored.version !== 2 || stored.parser !== this.parserId || !Array.isArray(stored.files)) return;
      this.files = new Map(stored.files.filter(value => ['symbols', 'declarations', 'functions', 'calls', 'includes', 'macros'].every(key => Array.isArray(value[key]))).map(value => [value.uri, value]));
    } catch { /* Missing, old or malformed snapshots are rebuilt from source. */ }
  }
  get(uri) { return this.files.get(uri); }
  stage(file) {
    const previous = this.files.get(file.uri); this.files.set(file.uri, file);
    if (typeof file.hash === 'string' && previous?.hash === file.hash && previous.project === file.project &&
      JSON.stringify(previous.stamp) === JSON.stringify(file.stamp)) return;
    this.schedule();
  }
  remove(uri) { if (this.files.delete(uri)) this.schedule(); }
  prune(live) { let changed = false; for (const uri of this.files.keys()) if (!live.has(uri)) { this.files.delete(uri); changed = true; } if (changed) this.schedule(); }
  schedule() { this.dirty = true; clearTimeout(this.timer); if (this.path) this.timer = setTimeout(() => this.flush().catch(this.report), 300); }
  async flush() {
    clearTimeout(this.timer); if (!this.dirty || !this.path) return this.writes;
    if (this.flushing) { await this.writes; return this.flush(); }
    this.dirty = false; this.flushing = true; const file = this.path, snapshot = [...this.files.values()];
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = `${file}.${process.pid}.${threadId}.tmp`;
      let handle;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        handle = await fs.open(temporary, 'w', 0o600);
        await handle.writeFile(`{"version":2,"parser":${JSON.stringify(this.parserId)},"files":[`);
        for (let at = 0; at < snapshot.length; at++) {
          const { scopeKey, indexExclude, ...facts } = snapshot[at];
          await handle.writeFile((at ? ',' : '') + JSON.stringify(facts));
          if (at % 32 === 31) await new Promise(resolve => setImmediate(resolve));
        }
        await handle.writeFile(']}'); await handle.close(); handle = undefined;
        await fs.rename(temporary, file);
      } catch (error) { this.dirty = true; throw error; }
      finally { try { await handle?.close(); } finally { this.flushing = false; } }
    });
    return this.writes;
  }
}
module.exports = { JsonIndexRepository };
