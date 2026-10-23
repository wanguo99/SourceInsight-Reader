'use strict';
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createParser, parseC } = require('./c-parser');
const { CIndex } = require('./c-index');
const { relativeUriPath } = require('./resources');
const { WorkerScheduler } = require('./infrastructure/worker-scheduler');
const { JsonIndexRepository } = require('./infrastructure/index-repository');
const { decodeSource } = require('./infrastructure/source-text');
const index = new CIndex(), scheduler = new WorkerScheduler();
const parserId = require('../vendor/tree-sitter/manifest.json').map(asset => asset.sha256).join(':') + ':facts-7';
const repository = new JsonIndexRepository(parserId, error => parentPort.postMessage({ diagnostic: String(error.message || error) }));
let parser, scanEpoch = 0, fileFailures = new Map(); const scans = new Set();
const summary = () => ({ ...index.summary(), failures: [...fileFailures].map(([uri, message]) => ({ uri, message })) });
const MAX_BYTES = 8 * 1024 * 1024;
async function parse(file) {
  if (file.text === undefined && (await fs.stat(file.path)).size > MAX_BYTES) throw new Error('文件超过本地索引 8 MiB 限制');
  const source = file.text ?? decodeSource(await fs.readFile(file.path), file.encoding);
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error('文件超过本地索引 8 MiB 限制');
  const hash = crypto.createHash('sha256').update(source).digest('hex'), previous = repository.get(file.uri);
  if (previous?.hash === hash) return { ...previous, project: file.project, scopeKey: file.scopeKey };
  parser ||= await createParser(); return { ...parseC(parser, source, file.uri, file.path), project: file.project, scopeKey: file.scopeKey };
}
async function* scan(message, context) {
  try {
    await repository.open(message.cachePath, message.force);
    const next = new Map(), failures = new Map(); let count = 0, yielded = Date.now();
    for (const file of message.files) {
      if (context.epoch !== scanEpoch) return { cancelled: true };
      try { const facts = await parse(file); next.set(file.uri, facts); if (file.text === undefined) repository.stage(facts); }
      catch (error) { failures.set(file.uri, error.message); }
      if (++count % 16 === 0 || Date.now() - yielded > 20) { yielded = Date.now(); parentPort.postMessage({ progress: { done: count, total: message.files.length } }); yield; }
    }
    if (context.epoch !== scanEpoch) return { cancelled: true };
    for (const [uri, facts] of context.overrides) {
      if (!facts) {
        next.delete(uri);
        if (context.failures.has(uri)) failures.set(uri, context.failures.get(uri)); else failures.delete(uri);
      }
      else if (message.scopeKey !== undefined && facts.scopeKey !== message.scopeKey) continue;
      else if (message.scopeRoots) {
        const root = [...message.scopeRoots].sort((a, b) => b.uri.length - a.uri.length).find(root => relativeUriPath(root.uri, facts.uri) !== undefined);
        if (root) { next.set(uri, { ...facts, project: root.project }); failures.delete(uri); }
      } else { next.set(uri, facts); failures.delete(uri); }
    }
    repository.prune(new Set(message.files.map(file => file.uri))); index.replace([...next.values()]); fileFailures = failures;
    // First snapshot is available before persistence. Flushing is independent of queries.
    repository.flush().catch(error => parentPort.postMessage({ diagnostic: error.message }));
    return summary();
  } finally { scans.delete(context); }
}
async function handle(message) {
  if (message.action === 'cancelScan') { scanEpoch++; return { cancelled: true }; }
  if (message.action === 'update') {
    const uri = message.file.uri;
    try {
      const facts = await parse(message.file); index.update(facts); fileFailures.delete(uri);
      for (const active of scans) { active.overrides.set(uri, facts); active.failures.delete(uri); }
      if (!message.dirty) repository.stage(facts);
    } catch (error) {
      fileFailures.set(uri, error.message); index.remove(uri);
      for (const active of scans) { active.overrides.set(uri, undefined); active.failures.set(uri, error.message); }
    }
    return summary();
  }
  if (message.action === 'remove') {
    for (const active of scans) { active.overrides.set(message.uri, undefined); active.failures.delete(message.uri); }
    repository.remove(message.uri); index.remove(message.uri); fileFailures.delete(message.uri); return summary();
  }
  if (message.action === 'prepare') return index.prepare(message.uri, message.position, message.name).map(fn => index.item(fn));
  if (message.action === 'definitions') return index.definitions(message.uri, message.position);
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
    const context = { epoch: ++scanEpoch, overrides: new Map(), failures: new Map() }; scans.add(context); job = scheduler.scan(scan(message, context));
  } else job = scheduler.submit(() => handle(message));
  job.then(result => parentPort.postMessage({ id: message.id, result }), error => parentPort.postMessage({ id: message.id, error: String(error.message || error) }));
});
