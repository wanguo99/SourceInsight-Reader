'use strict';
const { parentPort } = require('node:worker_threads');
const { findMatches } = require('./domain/text-search');

parentPort.on('message', message => {
  try {
    // The host already has each source line. Do not clone a potentially huge
    // identical line once per hit across the Worker boundary.
    const rows = findMatches(message.text, message.query, message.options, message.limit)
      .map(({ lineText, ...row }) => row);
    parentPort.postMessage({ id: message.id, rows });
  } catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
});
