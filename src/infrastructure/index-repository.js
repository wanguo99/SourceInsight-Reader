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
  stage(file) { this.files.set(file.uri, file); this.schedule(); }
  remove(uri) { this.files.delete(uri); this.schedule(); }
  prune(live) { for (const uri of this.files.keys()) if (!live.has(uri)) this.files.delete(uri); this.schedule(); }
  schedule() { this.dirty = true; clearTimeout(this.timer); if (this.path) this.timer = setTimeout(() => this.flush().catch(this.report), 300); }
  async flush() {
    clearTimeout(this.timer); if (!this.dirty || !this.path) return this.writes;
    this.dirty = false; const file = this.path;
    const content = JSON.stringify({ version: 2, parser: this.parserId, files: [...this.files.values()] });
    this.writes = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${threadId}.tmp`;
      try { await fs.writeFile(temporary, content); await fs.rename(temporary, file); }
      catch (error) { this.dirty = true; throw error; }
    });
    return this.writes;
  }
}
module.exports = { JsonIndexRepository };
