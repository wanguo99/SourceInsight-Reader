'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const worker = new Worker(path.join(__dirname, '../../src/index-worker.js'));
worker.on('message', message => { if (process.connected) process.send(message); });
worker.on('error', error => { console.error(error); process.exit(1); });
worker.on('exit', () => process.exit(0));
process.on('message', message => worker.postMessage(message));
process.on('disconnect', () => { void worker.terminate(); });
