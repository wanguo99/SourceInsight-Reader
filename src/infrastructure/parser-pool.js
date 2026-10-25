'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const cancelled = () => Object.assign(new Error('解析任务已取消'), { code: 'INDEX_POOL_CLOSED' });
class ParserPool {
  constructor(plan, shared, baselineRss, report = message => {}, cpuShared = new SharedArrayBuffer(32)) {
    this.plan = plan; this.shared = shared; this.baselineRss = baselineRss; this.report = report;
    this.cpuShared = cpuShared;
    this.workers = []; this.queue = []; this.sequence = 0; this.active = 0; this.peakActive = 0; this.disabled = false;
  }
  start() {
    if (this.workers.length || this.disabled) return;
    for (let at = 0; at < this.plan.parsers; at++) {
      const worker = new Worker(path.join(__dirname, '../parse-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: this.plan.parserMb },
        workerData: { plan: this.plan, memory: this.shared, cpuShared: this.cpuShared, slot: at + 1, baselineRss: this.baselineRss } });
      const slot = { worker, job: undefined, memorySlot: at + 1 }; this.workers.push(slot);
      worker.on('message', message => {
        const job = slot.job; if (!job || job.id !== message.id) return;
        slot.job = undefined; this.active--;
        if (message.error) job.reject(Object.assign(new Error(message.error), { code: message.code })); else job.resolve(message.facts);
        this.dispatch();
      });
      worker.on('error', error => { this.report(`解析线程异常，将降级为串行：${error.message}`); void this.close(error); });
      worker.on('exit', code => { if (!this.disabled) void this.close(Object.assign(new Error(`解析线程退出 (${code})`), { code: 'INDEX_PARSER_EXIT' })); });
    }
  }
  parse(task, foreground = false) {
    if (this.disabled) return Promise.reject(cancelled());
    this.start();
    return new Promise((resolve, reject) => {
      const job = { id: ++this.sequence, task, resolve, reject };
      foreground ? this.queue.unshift(job) : this.queue.push(job); this.dispatch();
    });
  }
  dispatch() {
    if (this.disabled) return;
    for (const slot of this.workers) if (!slot.job && this.queue.length) {
      const job = this.queue.shift(); slot.job = job; this.active++; this.peakActive = Math.max(this.peakActive, this.active);
      try { slot.worker.postMessage({ id: job.id, task: job.task }); }
      catch (error) { slot.job = undefined; this.active--; job.reject(error); }
    }
  }
  /** @param {Error} [error] */
  close(error = cancelled()) {
    if (this.closing) return this.closing;
    this.disabled = true;
    for (const job of this.queue.splice(0)) job.reject(error);
    this.closing = Promise.all(this.workers.map(async slot => {
      if (slot.job) { slot.job.reject(error); slot.job = undefined; }
      await slot.worker.terminate(); Atomics.store(new Int32Array(this.shared), slot.memorySlot, 0);
    })).then(() => { this.workers = []; this.active = 0; });
    return this.closing;
  }
}
module.exports = { ParserPool };
