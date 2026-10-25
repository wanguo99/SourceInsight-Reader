'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { IndexDatabase, databasePath } = require('./infrastructure/index-database');
const { PARSER_ID } = require('./infrastructure/index-schema');
const stores = new Map();
function store(message) {
  const file = databasePath(message.directory, message.project);
  if (!stores.has(file)) stores.set(file, new IndexDatabase(file, message.project, PARSER_ID));
  return stores.get(file);
}
function buildKey(message, database) {
  const hash = crypto.createHash('sha256').update(message.configuration || '');
  for (const relative of ['.clangd', 'compile_commands.json', 'compile_flags.txt', '.vscode/c_cpp_properties.json', 'CMakePresets.json', ...(message.buildFiles || [])]) {
    const file = path.resolve(message.root, relative);
    try { const info = fs.statSync(file); hash.update(`${file}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  hash.update(String(database.meta('revision') || 0)); return hash.digest('hex');
}
function handle(message) {
  if (message.action === 'close') { for (const database of stores.values()) database.close(); stores.clear(); return {}; }
  const database = store(message);
  const snapshot = { ...message.snapshot, provider: 'languageService', buildKey: buildKey(message, database) };
  if (message.action === 'publish') {
    if (Buffer.byteLength(JSON.stringify(snapshot.data)) > 16 * 1024 * 1024) return { persisted: false, reason: 'size' };
    return database.publish(snapshot);
  }
  if (message.action === 'read') return database.read(snapshot);
  throw new Error('Unknown index database request');
}
// A query may share the WAL with the parser worker. Keep the extension host
// responsive while SQLite's bounded busy timeout waits for a transaction.
let queue = Promise.resolve();
parentPort.on('message', message => {
  queue = queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try { parentPort.postMessage({ id: message.id, result: handle(message) }); if (message.action === 'close') parentPort.close(); return; }
      catch (error) {
        if (attempt < 2 && /locked|busy/i.test(error.message)) { await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1))); continue; }
        parentPort.postMessage({ id: message.id, error: error.message }); return;
      }
    }
  });
});
