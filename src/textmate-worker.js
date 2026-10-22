'use strict';
const { parentPort } = require('node:worker_threads');
const { TextmateEngine } = require('./infrastructure/textmate-engine');
const engine = new TextmateEngine();
let jobs = Promise.resolve(), latest;
parentPort.on('message', message => {
  latest = message.id;
  jobs = jobs.catch(() => {}).then(async () => {
    try { parentPort.postMessage({ id: message.id, spans: latest !== message.id ? [] : await engine.colorize(message, () => latest !== message.id) }); }
    catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
  });
});
