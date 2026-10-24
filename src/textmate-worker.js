'use strict';
const { parentPort } = require('node:worker_threads');
const { TextmateEngine } = require('./infrastructure/textmate-engine');
const engine = new TextmateEngine();
let jobs = Promise.resolve(), latest;
parentPort.on('message', message => {
  latest = message.id;
  jobs = jobs.catch(() => {}).then(async () => {
    try {
      const result = latest !== message.id ? [] : await engine.colorize(message, () => latest !== message.id);
      parentPort.postMessage(Array.isArray(result) ? { id: message.id, spans: result } : { id: message.id, needsText: true });
    }
    catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
  });
});
