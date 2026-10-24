'use strict';
const v8 = require('node:v8');
const MiB = 1024 * 1024;
class IndexMemoryError extends Error {
  constructor() { super('本地索引达到内存预算，已保留部分结果；请缩小索引范围或增加 indexMemoryLimitMb 后重建'); this.code = 'INDEX_MEMORY_BUDGET'; }
}
class IndexMemory {
  constructor(limitMb = 1024, usage = process.memoryUsage) {
    this.limit = Math.min(limitMb * MiB, v8.getHeapStatistics().heap_size_limit);
    this.usage = usage;
  }
  snapshot() {
    const value = this.usage();
    return { heapUsedMb: Math.round(value.heapUsed / MiB), arrayBuffersMb: Math.round((value.arrayBuffers || 0) / MiB), limitMb: Math.round(this.limit / MiB) };
  }
  available(fraction = 0.65) { const value = this.usage(); return value.heapUsed + (value.arrayBuffers || 0) < this.limit * fraction; }
  check() { if (!this.available(0.82)) throw new IndexMemoryError(); }
}
module.exports = { IndexMemory, IndexMemoryError };
