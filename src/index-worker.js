'use strict';
const { parentPort, threadId } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createParser, parseC } = require('./c-parser');
const { CIndex } = require('./c-index');
const VERSION = 1;
const PARSER_ID = require('../vendor/tree-sitter/manifest.json').map(asset => asset.sha256).join(':');
const index = new CIndex();
let parser, cachePath, disk = new Map();
const MAX_BYTES = 8 * 1024 * 1024;

async function persist() {
  if (!cachePath) return;
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.${threadId}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: VERSION, parser: PARSER_ID, files: [...disk.values()] }));
  await fs.rename(temporary, cachePath);
}
async function parse(file) {
  if (file.text === undefined) {
    const stat = await fs.stat(file.path);
    if (stat.size > MAX_BYTES) throw new Error('文件超过本地索引 8 MiB 限制');
  }
  const source = file.text ?? await fs.readFile(file.path, 'utf8');
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error('文件超过本地索引 8 MiB 限制');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const previous = disk.get(file.uri);
  if (previous?.hash === hash) return previous;
  parser ||= await createParser();
  return parseC(parser, source, file.uri, file.path);
}

async function handle(message) {
  const { action } = message;
  if (action === 'scan') {
    cachePath = message.cachePath;
    if (!disk.size && cachePath && !message.force) {
      try {
        const stored = JSON.parse(await fs.readFile(cachePath, 'utf8'));
        if (stored.version === VERSION && stored.parser === PARSER_ID && Array.isArray(stored.files)) {
          disk = new Map(stored.files.filter(file => Array.isArray(file.symbols) && Array.isArray(file.declarations) && Array.isArray(file.functions) && Array.isArray(file.calls) &&
            Array.isArray(file.includes) && Array.isArray(file.macros)).map(file => [file.uri, file]));
        }
      } catch { /* Missing or broken cache is rebuilt from source. */ }
    }
    if (message.force) disk.clear();
    const next = [], failures = [];
    let count = 0;
    for (const file of message.files) {
      try {
        const facts = await parse(file); next.push(facts);
        if (file.text === undefined) disk.set(file.uri, facts);
      } catch (error) {
        failures.push({ uri: file.uri, message: String(error.message || error) });
        // Keep the last usable facts, but make the partial scan explicit.
        if (disk.has(file.uri)) next.push(disk.get(file.uri));
      }
      if (++count % 20 === 0) parentPort.postMessage({ progress: { done: count, total: message.files.length } });
    }
    const live = new Set(message.files.map(file => file.uri));
    for (const uri of disk.keys()) if (!live.has(uri)) disk.delete(uri);
    index.replace(next);
    try { await persist(); } catch (error) { failures.push({ uri: cachePath, message: `索引缓存保存失败：${error.message}` }); }
    return { ...index.summary(), failures };
  }
  if (action === 'update') {
    const facts = await parse(message.file);
    index.update(facts);
    const failures = [];
    if (!message.dirty) {
      disk.set(message.file.uri, facts);
      try { await persist(); } catch (error) { failures.push({ uri: cachePath, message: `索引缓存保存失败：${error.message}` }); }
    }
    return { ...index.summary(), failures };
  }
  if (action === 'remove') {
    disk.delete(message.uri); index.remove(message.uri);
    const failures = [];
    try { await persist(); } catch (error) { failures.push({ uri: cachePath, message: `索引缓存保存失败：${error.message}` }); }
    return { ...index.summary(), failures };
  }
  if (action === 'prepare') return index.prepare(message.uri, message.position, message.name).map(fn => index.item(fn));
  if (action === 'definitions') return index.definitions(message.uri, message.position).map(fn => index.item(fn));
  if (action === 'symbols') return index.symbols(message.uri);
  if (action === 'calls') return index.calls(message.item, message.direction);
  throw new Error(`Unknown C index request: ${action}`);
}
let queue = Promise.resolve();
parentPort.on('message', message => {
  queue = queue.then(async () => {
    try { parentPort.postMessage({ id: message.id, result: await handle(message) }); }
    catch (error) { parentPort.postMessage({ id: message.id, error: String(error.message || error) }); }
  });
});
