'use strict';
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const MiB = 1048576;

function resourcePlan(settings = {}, host = {}) {
  const cpus = Math.max(1, host.cpus ?? os.availableParallelism());
  const cpuPercent = Number.isInteger(settings.cpuPercent) && settings.cpuPercent >= 5 && settings.cpuPercent <= 25 ? settings.cpuPercent : 25;
  const requestedMb = Number.isInteger(settings.memoryMb) && settings.memoryMb >= 128 && settings.memoryMb <= 8192 ? settings.memoryMb : 1024;
  const availableMb = host.availableMb ?? Math.min(os.freemem(), process.availableMemory?.() ?? os.freemem()) / MiB;
  const physicalMb = host.physicalMb ?? os.totalmem() / MiB;
  const memoryMb = Math.max(128, Math.floor(Math.min(requestedMb, physicalMb / 4, availableMb / 4) / 16) * 16);
  // Reserve one CPU slot for the coordinator, including database/graph work.
  const cpuSlots = Math.max(1, Math.floor(cpus * cpuPercent / 100));
  const parserMb = 256, reserveMb = Math.max(512, Math.floor(memoryMb / 2));
  const parsers = Math.max(0, Math.min(4, cpuSlots - 1, Math.floor((memoryMb - reserveMb) / parserMb)));
  return { cpus, cpuPercent, cpuSlots, parsers, parserMb, coordinatorMb: memoryMb - parsers * parserMb, memoryMb, requestedMb,
    cpuFraction: Math.min(0.85, cpus * cpuPercent / 100 / (parsers + 1) * 0.85), lowMemory: availableMb < 256 };
}

// Cooperative per-thread CPU accounting. Small machines also get a duty cycle;
// unused idle time cannot accumulate into an unlimited later CPU burst.
class CpuBudget {
  constructor(fraction, clock = () => performance.now(), cpu, sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
    this.waitedWallMs = 0; this.heartbeat = undefined; this.group = undefined;
    this.cpu = cpu || (() => {
      if (process.threadCpuUsage) { const value = process.threadCpuUsage(); return (value.user + value.system) / 1000; }
      return performance.eventLoopUtilization().active - this.waitedWallMs;
    });
    this.fraction = fraction; this.clock = clock; this.sleep = sleep;
    this.wall = clock(); this.used = this.cpu(); this.credit = fraction * 10; this.sleptMs = 0;
  }
  check() {
    const now = this.clock(), used = this.cpu();
    this.credit = Math.min(this.fraction * 50, this.credit + (now - this.wall) * this.fraction - (used - this.used));
    this.wall = now; this.used = used;
    while (this.credit < -1) {
      this.wait(Math.min(25, -this.credit / this.fraction));
      const wall = this.clock(), cpu = this.cpu(); this.credit += (wall - this.wall) * this.fraction - (cpu - this.used);
      this.wall = wall; this.used = cpu;
    }
    // Include process-wide GC/WASM helpers as well. Other extension-host work
    // can also cause backpressure, so keep each cooperative pause bounded.
    let waited = 0, delay;
    while (this.group && (delay = this.group.delay()) > 1 && waited < 250) { const next = Math.min(25, delay); this.wait(next); waited += next; }
  }
  wait(delay) {
    const before = this.clock(); this.sleep(delay); this.sleptMs += delay; this.waitedWallMs += this.clock() - before;
    if (this.clock() - (this.lastHeartbeat || 0) > 2000) { this.lastHeartbeat = this.clock(); this.heartbeat?.(); }
  }
}

class ProcessCpuBudget {
  constructor(plan, shared, clock = () => Number(process.hrtime.bigint() / 1000n) / 1000, usage = () => {
    const value = process.cpuUsage(); return (value.user + value.system) / 1000;
  }) {
    this.quota = plan.cpus * plan.cpuPercent / 100 * 0.9; this.lock = new Int32Array(shared, 0, 1); this.state = new Float64Array(shared, 8, 3);
    this.clock = clock; this.usage = usage;
  }
  delay() {
    if (Atomics.compareExchange(this.lock, 0, 0, 1) !== 0) return 0;
    try {
      const wall = this.clock(), used = this.usage();
      if (!this.state[0]) { this.state[0] = wall; this.state[1] = used; return 0; }
      const credit = Math.max(-this.quota * 1000, Math.min(this.quota * 10, this.state[2] + (wall - this.state[0]) * this.quota - (used - this.state[1])));
      this.state[0] = wall; this.state[1] = used; this.state[2] = credit;
      return Math.max(0, -credit / this.quota);
    } finally { Atomics.store(this.lock, 0, 0); }
  }
}

class SharedMemoryBudget {
  constructor(plan, memory, shared, slot = 0, baselineRss = process.memoryUsage.rss()) {
    this.plan = plan; this.memory = memory; this.usage = new Int32Array(shared); this.slot = slot; this.baselineRss = baselineRss; this.observedPeakMb = 0;
  }
  update() { const value = process.memoryUsage(); Atomics.store(this.usage, this.slot, Math.ceil((value.heapUsed + value.arrayBuffers) / 1024)); }
  usedMb() { let used = 0; for (let at = 0; at < this.usage.length; at++) used += Atomics.load(this.usage, at); return used / 1024; }
  available(fraction = 0.82) {
    this.update();
    if (!this.checkedAt || Date.now() - this.checkedAt > 1000) {
      this.checkedAt = Date.now(); this.systemAvailableMb = Math.min(os.freemem(), process.availableMemory?.() ?? os.freemem()) / MiB;
    }
    const used = this.usedMb(); this.observedPeakMb = Math.max(this.observedPeakMb, used);
    return this.systemAvailableMb >= Math.max(256, this.plan.memoryMb / 4) && this.memory.available(fraction) && used < this.plan.memoryMb * fraction &&
      process.memoryUsage.rss() - this.baselineRss < this.plan.memoryMb * MiB;
  }
  snapshot() { this.update(); const used = this.usedMb(); this.observedPeakMb = Math.max(this.observedPeakMb, used);
    return { totalLimitMb: this.plan.memoryMb, requestedTotalMb: this.plan.requestedMb, managedUsedMb: Math.round(used), observedManagedPeakMb: Math.round(this.observedPeakMb),
    rssGrowthMb: Math.max(0, Math.round((process.memoryUsage.rss() - this.baselineRss) / MiB)) }; }
}
/** @param {any} summary */
function canResumeBudget(summary, attempted = false) {
  return !attempted && summary?.memoryLimited === true && summary.files > 0 && summary.deferredFiles > 0 &&
    summary.database?.engine === 'sqlite' && summary.database.volatileProjects === 0;
}
module.exports = { resourcePlan, CpuBudget, ProcessCpuBudget, SharedMemoryBudget, canResumeBudget };
