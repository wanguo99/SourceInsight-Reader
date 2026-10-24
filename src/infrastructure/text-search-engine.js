'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

class TextSearchEngine {
  constructor({ timeout = 1500 } = {}) { this.timeout = timeout; this.sequence = 0; this.pending = new Map(); }
  match(text, query, options, limit) {
    if (this.disposed) return Promise.reject(new Error('检索已结束'));
    if (!this.worker) {
      const worker = new Worker(path.join(__dirname, '../text-search-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 128 } });
      this.worker = worker;
      worker.on('message', message => {
        const entry = this.pending.get(message.id); if (!entry) return;
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.rows);
      });
      worker.on('error', error => { if (this.worker === worker) this.cancel(error); });
      worker.on('exit', code => { if (this.worker === worker) this.cancel(new Error(`检索线程退出：${code}`)); });
      worker.unref();
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence, timer = setTimeout(() => this.cancel(new Error('检索计算超时，请缩小范围或简化查询')), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, text, query, options, limit });
    });
  }
  cancel(error = new Error('检索已取消')) {
    const worker = this.worker; this.worker = undefined;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); worker?.terminate();
  }
  dispose() { this.disposed = true; this.cancel(); }
}
module.exports = { TextSearchEngine };
