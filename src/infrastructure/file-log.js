'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Batched, serialized writes keep disk latency off the extension host's hot path.
class FileLog {
  constructor(directory, identity, report, limits = {}) {
    this.file = path.join(directory, `sourceinsight-reader-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12)}-${process.pid}.log`);
    this.report = report; this.limit = limits.fileBytes || 5 * 1024 * 1024;
    this.backups = limits.backups ?? 3; this.queueLimit = limits.queueBytes || 1024 * 1024;
    this.buffer = []; this.queuedBytes = 0; this.dropped = 0; this.writing = Promise.resolve();
  }
  appendLine(message) {
    if (this.closed || this.failed) return;
    const text = String(message);
    const line = `${new Date().toISOString()} ${text.slice(0, 16384)}${text.length > 16384 ? ' [日志内容已截断]' : ''}\n`, bytes = Buffer.byteLength(line);
    if (bytes > this.queueLimit || this.queuedBytes + bytes > this.queueLimit) { this.dropped++; return; }
    this.buffer.push(line); this.queuedBytes += bytes;
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), 200); this.timer.unref?.(); }
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.draining) return this.writing;
    this.draining = true;
    this.writing = (async () => {
      try {
        while (this.buffer.length || this.dropped) {
          const lines = this.buffer.splice(0), dropped = this.dropped; this.dropped = 0;
          const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
          if (dropped) lines.push(`${new Date().toISOString()} [日志限流] ${dropped} 条日志未写入文件；输出面板仍保留原始输出\n`);
          if (!this.initialized) {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            this.size = await fs.stat(this.file).then(stat => stat.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
            this.initialized = true;
          }
          let chunk = '', chunkBytes = 0;
          const write = async () => {
            if (!chunk) return;
            await fs.appendFile(this.file, chunk, { encoding: 'utf8', mode: 0o600 });
            this.size += chunkBytes; chunk = ''; chunkBytes = 0;
          };
          for (const line of lines) {
            const length = Buffer.byteLength(line);
            if (this.size + chunkBytes && this.size + chunkBytes + length > this.limit) { await write(); await this.rotate(); }
            chunk += line; chunkBytes += length;
          }
          await write();
          this.queuedBytes -= bytes;
        }
      } catch (error) {
        this.failed = true; this.buffer = []; this.queuedBytes = 0; this.dropped = 0;
        try { this.report(`日志文件写入失败（输出面板继续可用）：${this.file} · ${error.message}`); } catch { /* The output channel may already be closed. */ }
      } finally { this.draining = false; }
    })();
    return this.writing;
  }
  async rotate() {
    for (let at = this.backups; at >= 1; at--) {
      const source = at === 1 ? this.file : `${this.file}.${at - 1}`, target = `${this.file}.${at}`;
      if (at === this.backups) await fs.rm(target, { force: true });
      try { await fs.rename(source, target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!this.backups) await fs.rm(this.file, { force: true });
    this.size = 0;
  }
  dispose() { this.closed = true; return this.flush(); }
}
module.exports = { FileLog };
