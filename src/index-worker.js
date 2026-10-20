'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createParser, parseC } = require('./c-parser');
const { CIndex } = require('./c-index');
const { relativeUriPath } = require('./resources');
const { WorkerScheduler } = require('./infrastructure/worker-scheduler');
const { JsonIndexRepository } = require('./infrastructure/index-repository');
const index = new CIndex(), scheduler = new WorkerScheduler();
const parserId = require('../vendor/tree-sitter/manifest.json').map(asset => asset.sha256).join(':') + ':facts-3';
const repository = new JsonIndexRepository(parserId, error => parentPort.postMessage({ diagnostic: String(error.message || error) }));
let parser, scanEpoch = 0; const scans = new Set();
const MAX_BYTES = 8 * 1024 * 1024;
async function parse(file) {
  if (file.text === undefined && (await fs.stat(file.path)).size > MAX_BYTES) throw new Error('文件超过本地索引 8 MiB 限制');
  const source = file.text ?? await fs.readFile(file.path, 'utf8');
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error('文件超过本地索引 8 MiB 限制');
  const hash = crypto.createHash('sha256').update(source).digest('hex'), previous = repository.get(file.uri);
  if (previous?.hash === hash) return { ...previous, project: file.project };
  parser ||= await createParser(); return { ...parseC(parser, source, file.uri, file.path), project: file.project };
}
async function* scan(message, context) {
  try {
    await repository.open(message.cachePath, message.force);
    const next = new Map(), failures = []; let count = 0, yielded = Date.now();
    for (const file of message.files) {
      if (context.epoch !== scanEpoch) return { cancelled: true };
      try { const facts = await parse(file); next.set(file.uri, facts); if (file.text === undefined) repository.stage(facts); }
      catch (error) { failures.push({ uri: file.uri, message: error.message }); if (repository.get(file.uri)) next.set(file.uri, repository.get(file.uri)); }
      if (++count % 16 === 0 || Date.now() - yielded > 20) { yielded = Date.now(); parentPort.postMessage({ progress: { done: count, total: message.files.length } }); yield; }
    }
    if (context.epoch !== scanEpoch) return { cancelled: true };
    for (const [uri, facts] of context.overrides) {
      if (!facts) next.delete(uri);
      else if (message.scopeProject) { if (facts.project === message.scopeProject) next.set(uri, facts); }
      else if (message.scopeRoots) {
        const root = [...message.scopeRoots].sort((a, b) => b.uri.length - a.uri.length).find(root => relativeUriPath(root.uri, facts.uri) !== undefined);
        if (root) next.set(uri, { ...facts, project: root.project });
      } else next.set(uri, facts);
    }
    repository.prune(new Set(next.keys())); index.replace([...next.values()]);
    // First snapshot is available before persistence. Flushing is independent of queries.
    repository.flush().catch(error => parentPort.postMessage({ diagnostic: error.message }));
    return { ...index.summary(), failures };
  } finally { scans.delete(context); }
}
async function handle(message) {
  if (message.action === 'cancelScan') { scanEpoch++; return { cancelled: true }; }
  if (message.action === 'update') {
    const facts = await parse(message.file); index.update(facts);
    for (const active of scans) active.overrides.set(facts.uri, facts);
    if (!message.dirty) repository.stage(facts);
    return { ...index.summary(), failures: [] };
  }
  if (message.action === 'remove') {
    for (const active of scans) active.overrides.set(message.uri, undefined);
    repository.remove(message.uri); index.remove(message.uri); return { ...index.summary(), failures: [] };
  }
  if (message.action === 'prepare') return index.prepare(message.uri, message.position, message.name).map(fn => index.item(fn));
  if (message.action === 'definitions') return index.definitions(message.uri, message.position).map(fn => index.item(fn));
  if (message.action === 'workspaceSymbols') return index.workspaceSymbols(message.query);
  if (message.action === 'symbols') return index.symbols(message.uri);
  if (message.action === 'callDiagnostics') return index.callDiagnostics(message.item, message.direction);
  if (message.action === 'calls') return index.calls(message.item, message.direction);
  if (message.action === 'flush') { await repository.flush(); return {}; }
  if (message.action === 'shutdown') { scanEpoch++; await repository.flush(); parentPort.close(); return {}; }
  throw new Error(`Unknown C index request: ${message.action}`);
}
parentPort.on('message', message => {
  let job;
  if (message.action === 'scan') {
    const context = { epoch: ++scanEpoch, overrides: new Map() }; scans.add(context); job = scheduler.scan(scan(message, context));
  } else job = scheduler.submit(() => handle(message));
  job.then(result => parentPort.postMessage({ id: message.id, result }), error => parentPort.postMessage({ id: message.id, error: String(error.message || error) }));
});
