'use strict';

class QueryError extends Error {
  constructor(code, message) { super(message); this.name = 'QueryError'; this.code = code; }
}

// A timed-out VS Code command may keep running: retain its slot until it really
// settles. Dropping a waiter must not permit an unbounded stream of hung work.
class QueryCoordinator {
  constructor({ limit = 8, now = Date.now } = {}) {
    this.limit = limit; this.now = now; this.epoch = 0; this.entries = new Map(); this.running = new Set();
    this.statistics = { started: 0, completed: 0, timeouts: 0, coalesced: 0, busy: 0, cancelled: 0 };
  }
  /** @template T @param {string} key @param {() => PromiseLike<T> | T} operation
   * @param {{timeout?:number, channel?:string}} options @returns {Promise<T>} */
  run(key, operation, { timeout = 5000, channel = 'semantic' } = {}) {
    if (this.disposed) return Promise.reject(new QueryError('cancelled', '查询已结束'));
    const identity = `${this.epoch}:${channel}:${key}`, previous = this.entries.get(identity);
    if (previous) { this.statistics.coalesced++; return previous.promise; }
    if ([...this.running].filter(entry => entry.channel === channel).length >= this.limit) {
      this.statistics.busy++;
      return Promise.reject(new QueryError('busy', '查询队列已满；后端仍在处理请求，请等待或重启语言服务后重试'));
    }
    const entry = { channel, started: this.now(), settled: false, timer: undefined, promise: undefined, cancel: undefined };
    entry.promise = new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (entry.settled) return;
        entry.settled = true; clearTimeout(entry.timer);
        if (error) reject(error); else resolve(value);
      };
      entry.cancel = () => { if (!entry.settled) this.statistics.cancelled++; finish(new QueryError('cancelled', '源码或配置已变化，查询已取消')); };
      entry.timer = setTimeout(() => {
        this.statistics.timeouts++;
        finish(new QueryError('timeout', `查询超时（${timeout}ms），请检查后端状态后重试`));
      }, Math.max(1, timeout));
      Promise.resolve().then(operation).then(value => {
        this.statistics.completed++; finish(undefined, value); this.release(identity, entry);
      }, error => { finish(error); this.release(identity, entry); });
    });
    this.statistics.started++; this.entries.set(identity, entry); this.running.add(entry);
    return entry.promise;
  }
  release(identity, entry) { this.running.delete(entry); if (this.entries.get(identity) === entry) this.entries.delete(identity); }
  invalidate() { this.epoch++; for (const entry of this.entries.values()) entry.cancel(); this.entries.clear(); }
  snapshot() { return { ...this.statistics, active: this.running.size, waiting: [...this.entries.values()].filter(entry => !entry.settled).length }; }
  dispose() { this.disposed = true; this.invalidate(); }
}

module.exports = { QueryCoordinator, QueryError };
