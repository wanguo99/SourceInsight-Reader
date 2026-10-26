'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { SourceParser } = require('./infrastructure/source-parser');
const { IndexMemory, IndexMemoryError } = require('./infrastructure/index-memory');
const { CpuBudget, ProcessCpuBudget, SharedMemoryBudget } = require('./infrastructure/index-resources');
const parser = new SourceParser(), memory = new IndexMemory(workerData.plan.parserMb);
const shared = new SharedMemoryBudget(workerData.plan, memory, workerData.memory, workerData.slot, workerData.baselineRss);
const cpu = new CpuBudget(workerData.plan.cpuFraction);
cpu.group = new ProcessCpuBudget(workerData.plan, workerData.cpuShared);
const check = () => { cpu.check(); memory.check(); if (!shared.available()) throw new IndexMemoryError(); };
Object.assign(check, { suspendedMs: () => cpu.waitedWallMs });
parentPort.on('message', async message => {
  try {
    check(); const facts = await parser.parse(message.task, check); check();
    const transfer = facts.identifierData ? [facts.identifierData.buffer] : [];
    parentPort.postMessage({ id: message.id, facts }, transfer);
  } catch (error) { parentPort.postMessage({ id: message.id, error: error.message,
    code: error instanceof WebAssembly.RuntimeError ? 'INDEX_PARSER_CORRUPT' : error.code }); }
  finally { shared.update(); }
});
