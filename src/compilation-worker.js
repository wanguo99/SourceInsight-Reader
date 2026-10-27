'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { compilationSources } = require('./infrastructure/compilation-sources');
const { CpuBudget } = require('./infrastructure/index-resources');
const { IndexMemory } = require('./infrastructure/index-memory');
const cpu = new CpuBudget(workerData.cpuFraction || 1), memory = new IndexMemory(workerData.memoryMb || 512);
compilationSources(workerData.database, workerData.roots, () => { cpu.check(); memory.check(); }, workerData.pathMappings).then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: error.message }));
