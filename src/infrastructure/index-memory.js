'use strict';
const v8 = require('node:v8');
const MiB = 1024 * 1024;
class IndexMemoryError extends Error {
  constructor() { super('本地索引达到内存预算，已保留部分结果；请缩小索引范围或调整索引资源预算 后重建'); this.code = 'INDEX_MEMORY_BUDGET'; }
}
class IndexMemory {
  constructor(limitMb = 1024, usage = process.memoryUsage) {
    this.requestedLimitMb = limitMb; this.engineLimit = v8.getHeapStatistics().heap_size_limit;
    this.limit = Math.min(limitMb * MiB, this.engineLimit);
    this.usage = usage;
  }
  snapshot() {
    const value = this.usage();
    return { heapUsedMb: Math.round(value.heapUsed / MiB), arrayBuffersMb: Math.round((value.arrayBuffers || 0) / MiB), limitMb: Math.round(this.limit / MiB),
      requestedLimitMb: this.requestedLimitMb, engineHeapLimitMb: Math.round(this.engineLimit / MiB) };
  }
  available(fraction = 0.65) { const value = this.usage(); return value.heapUsed + (value.arrayBuffers || 0) < this.limit * fraction; }
  check() { if (!this.available(0.82)) throw new IndexMemoryError(); }
}
module.exports = { IndexMemory, IndexMemoryError };
