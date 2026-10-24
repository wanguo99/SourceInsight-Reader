'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { threadId } = require('node:worker_threads');
const { encodeFacts, decodeFacts } = require('./identifier-table');
const MAX_CACHE_LINE = 16 * 1024 * 1024;
const MAX_LEGACY_CACHE = 2 * 1024 * 1024;
// Each file occupies one bounded JSON line; the whole document remains valid
// version-2 JSON for old tools, but startup never materializes its full string.
class JsonIndexRepository {
  constructor(parserId, report = error => {}) { this.parserId = parserId; this.report = report; this.files = new Map(); this.writes = Promise.resolve(); this.dirty = false; }
  async open(file, force = false, options = {}) {
    this.path = file; this.loadingLimited = false;
    if (force) { this.files.clear(); return; }
    if (options.live) this.prune(options.live);
    if (this.files.size || !file) return;
    let stream, completed = false;
    const accept = value => {
      if (options.live && !options.live.has(value.uri)) return;
      if (!['symbols', 'declarations', 'functions', 'calls', 'includes', 'macros'].every(key => Array.isArray(value[key]))) return;
      this.files.set(value.uri, decodeFacts(value));
    };
    try {
      stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 });
      let buffer = '', header = false;
      const line = text => {
        if (!header) {
          if (text.endsWith('"files":[')) {
            const stored = JSON.parse(text + ']}');
            if (stored.version !== 2 || stored.parser !== this.parserId) return false;
            header = true;
          } else {
            // Small legacy one-line caches remain readable. Large ones are
            // rebuilt from source before JSON.parse can exhaust the heap.
            if (text.length > MAX_LEGACY_CACHE) throw new Error('旧索引缓存过大，将从源码重建');
            const stored = JSON.parse(text);
            if (stored.version === 2 && stored.parser === this.parserId && Array.isArray(stored.files)) for (const value of stored.files) {
              if (options.canLoad && !options.canLoad()) { this.loadingLimited = true; break; } accept(value);
            }
            completed = true; return false;
          }
        } else if (text === ']}') { completed = true; return false; }
        else if (text) accept(JSON.parse(text.replace(/^,/, '')));
        return true;
      };
      for await (const chunk of stream) {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          if (options.canLoad && !options.canLoad()) { this.loadingLimited = true; return; }
          const text = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
          if (text.length > (options.maxLineChars || MAX_CACHE_LINE)) throw new Error('索引缓存单文件记录过大，将从源码重建');
          if (text && !line(text)) return;
        }
        if (buffer.length > (header ? options.maxLineChars || MAX_CACHE_LINE : MAX_LEGACY_CACHE)) throw new Error('旧索引缓存过大，将使用流式缓存重建');
      }
      if (buffer.trim()) line(buffer.trim());
      if (!completed) throw new Error('Incomplete cache snapshot');
    } catch (error) {
      this.files.clear();
      if (error.code !== 'ENOENT') this.report(error);
    } finally {
      stream?.destroy();
      // An early budget exit keeps already decoded files, unlike corrupt input.
    }
  }
  get(uri) { return this.files.get(uri); }
  pause() { this.paused = (this.paused || 0) + 1; clearTimeout(this.timer); }
  resume() { this.paused = Math.max(0, (this.paused || 0) - 1); if (!this.paused && this.dirty) this.schedule(); }
  stage(file) {
    const previous = this.files.get(file.uri); this.files.set(file.uri, file);
    if (typeof file.hash === 'string' && previous?.hash === file.hash && previous.project === file.project &&
      JSON.stringify(previous.stamp) === JSON.stringify(file.stamp)) return;
    this.schedule();
  }
  remove(uri) { if (this.files.delete(uri)) this.schedule(); }
  prune(live) { let changed = false; for (const uri of this.files.keys()) if (!live.has(uri)) { this.files.delete(uri); changed = true; } if (changed) this.schedule(); }
  schedule() { this.dirty = true; clearTimeout(this.timer); if (this.path && !this.paused) this.timer = setTimeout(() => this.flush().catch(this.report), 300); }
  async flush() {
    clearTimeout(this.timer); if (!this.dirty || !this.path) return this.writes;
    if (this.flushing) { await this.writes; return this.flush(); }
    this.dirty = false; this.flushing = true; const file = this.path, snapshot = [...this.files.keys()];
    this.writes = this.writes.catch(() => {}).then(async () => {
      const temporary = `${file}.${process.pid}.${threadId}.tmp`;
      let handle, written = 0;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        handle = await fs.open(temporary, 'w', 0o600);
        await handle.writeFile(`{"version":2,"parser":${JSON.stringify(this.parserId)},"files":[\n`);
        for (const uri of snapshot) {
          // Fetch one live value at a time; a flush must not retain an old
          // project's entire facts graph while a forced rescan replaces it.
          const facts = this.files.get(uri); if (!facts) continue;
          const text = JSON.stringify(encodeFacts(facts));
          if (text.length > MAX_CACHE_LINE) { this.report(new Error('单文件索引快照过大，未写缓存：' + uri)); continue; }
          await handle.writeFile((written++ ? ',' : '') + text + '\n');
          if (written % 16 === 0) await new Promise(resolve => setImmediate(resolve));
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
