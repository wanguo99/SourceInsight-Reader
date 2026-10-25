'use strict';
// One writer, bounded scan batches, foreground priority. Queries observe only
// committed index snapshots; edits received during scans are applied as overlays.
class WorkerScheduler {
  constructor() { this.foreground = []; this.background = []; this.running = false; }
  submit(operation) { return new Promise((resolve, reject) => { this.foreground.push({ operation, resolve, reject }); this.pump(); }); }
  scan(iterator) { return new Promise((resolve, reject) => { this.background.push({ iterator, resolve, reject }); this.pump(); }); }
  async pump() {
    if (this.running) return; this.running = true;
    try {
      while (this.foreground.length || this.background.length) {
        for (let i = 0; i < 8 && this.foreground.length; i++) {
          const job = this.foreground.shift(); try { job.resolve(await job.operation()); } catch (error) { job.reject(error); }
        }
        const job = this.background[0];
        if (job && !job.waiting) {
          try {
            const next = await job.iterator.next();
            if (next.done) { this.background.shift(); job.resolve(next.value); }
            else if (next.value?.wait) {
              job.waiting = true;
              Promise.resolve(next.value.wait).then(() => { job.waiting = false; this.pump(); }, () => { job.waiting = false; this.pump(); });
            }
          }
          catch (error) { this.background.shift(); job.reject(error); }
        }
        if (!this.foreground.length && this.background[0]?.waiting) break;
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally { this.running = false; }
  }
}
module.exports = { WorkerScheduler };
