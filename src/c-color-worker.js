'use strict';
const { parentPort } = require('node:worker_threads');
const { createParser } = require('./c-parser');
const { cColorSpans } = require('./infrastructure/c-color-spans');
let parser;
parentPort.on('message', async message => {
  try {
    parser ||= await createParser();
    const spans = cColorSpans(parser, message.text);
    parentPort.postMessage({ id: message.id, spans });
  } catch (error) { parentPort.postMessage({ id: message.id, error: String(error) }); }
});
