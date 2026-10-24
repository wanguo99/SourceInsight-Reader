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
async function parse(file, force = false) {
  const previous = repository.get(file.uri); let stamp;
  if (file.text === undefined) {
    const info = await fs.stat(file.path);
    if (info.size > MAX_BYTES) throw new Error('文件超过本地索引 8 MiB 限制');
    stamp = { size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, inode: String(info.ino), encoding: file.encoding || 'utf8' };
    if (!force && previous && JSON.stringify(previous.stamp) === JSON.stringify(stamp)) return { ...previous, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude };
  }
  const source = file.text ?? decodeSource(await fs.readFile(file.path), file.encoding);
  if (Buffer.byteLength(source) > MAX_BYTES) throw new Error('文件超过本地索引 8 MiB 限制');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  if (previous?.hash === hash) return { ...previous, stamp, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude };
  parser ||= await createParser(); return { ...parseC(parser, source, file.uri, file.path), stamp, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude };
}
async function* scan(message, context) {
  try {
    parentPort.postMessage({ progress: { id: message.id, done: 0, total: message.files.length } });
    await repository.open(message.cachePath, message.force);
    const next = new Map(), failures = new Map(); let count = 0, yielded = Date.now(), published = index.files.size > 0;
    for (const file of message.files) {
      if (context.epoch !== scanEpoch) return { cancelled: true };
      try { const facts = await parse(file, message.force); next.set(file.uri, facts); if (file.text === undefined) repository.stage(facts); }
      catch (error) { failures.set(file.uri, error.message); }
      count++;
      if (!published && count >= 16 && count < message.files.length) {
        const partial = new Map(next);
        for (const [uri, facts] of context.overrides) {
          if (!facts) partial.delete(uri);
          else if ((message.scopeKey === undefined || facts.scopeKey === message.scopeKey) && (message.indexExclude === undefined || facts.indexExclude === message.indexExclude)) partial.set(uri, facts);
        }
        index.replace([...partial.values()]); fileFailures = new Map(failures); published = true;
        parentPort.postMessage({ snapshot: { scopeKey: message.scopeKey, indexExclude: message.indexExclude, uris: [...partial.keys()], summary: summary() } });
      }
      if (count % 16 === 0 || Date.now() - yielded > 20) { yielded = Date.now(); parentPort.postMessage({ progress: { id: message.id, done: count, total: message.files.length } }); yield; }
    }
    if (context.epoch !== scanEpoch) return { cancelled: true };
    for (const [uri, facts] of context.overrides) {
      if (!facts) {
        next.delete(uri);
        if (context.failures.has(uri)) failures.set(uri, context.failures.get(uri)); else failures.delete(uri);
      }
      else if (message.scopeKey !== undefined && facts.scopeKey !== message.scopeKey) continue;
      else if (message.indexExclude !== undefined && facts.indexExclude !== message.indexExclude) continue;
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
  if (message.action === 'updateBatch') {
    const next = new Map(index.files);
    for (const entry of message.files) {
      const uri = entry.file.uri;
      try {
        if (entry.remove) {
          next.delete(uri); repository.remove(uri); fileFailures.delete(uri);
          for (const active of scans) { active.overrides.set(uri, undefined); active.failures.delete(uri); }
        } else {
          const facts = await parse(entry.file, true); next.set(uri, facts); fileFailures.delete(uri);
          if (!entry.dirty) repository.stage(facts);
          for (const active of scans) { active.overrides.set(uri, facts); active.failures.delete(uri); }
        }
      } catch (error) {
        next.delete(uri); fileFailures.set(uri, error.message);
        for (const active of scans) { active.overrides.set(uri, undefined); active.failures.set(uri, error.message); }
      }
    }
    index.replace([...next.values()]); return summary();
  }
  if (message.action === 'update') {
    const uri = message.file.uri;
    try {
      const facts = await parse(message.file, true); index.update(facts); fileFailures.delete(uri);
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
  if (message.action === 'includeRelations') return index.includeRelations(message.uri, message.incoming);
  if (message.action === 'workspaceSymbols') return index.workspaceSymbols(message.query);
  if (message.action === 'symbols') return index.symbols(message.uri);
  if (message.action === 'callDiagnostics') return index.callDiagnostics(message.item, message.direction);
  if (message.action === 'calls') return index.calls(message.item, message.direction);
  if (message.action === 'flush') { await repository.flush(); return {}; }
  if (message.action === 'shutdown') { scanEpoch++; await repository.flush(); parentPort.close(); return {}; }
  throw new Error(`Unknown C index request: ${message.action}`);
}
async function* references(message) {
  const generation = index.generation, deadline = Date.now() + 3000, locations = []; let checked = 0;
  if (index.definitions(message.uri, message.position).length !== 1) return { locations, ambiguous: true };
  for (const location of index.referenceSites(message.uri, message.position)) {
    if (index.generation !== generation) throw new Error('源码索引已变化，请刷新引用');
    if (location) locations.push(location);
    if (locations.length >= 20000 || Date.now() > deadline) return { locations, incomplete: true };
    if (++checked % 64 === 0) yield;
  }
  return { locations };
}
parentPort.on('message', message => {
  let job;
  if (message.action === 'scan') {
    const context = { epoch: ++scanEpoch, overrides: new Map(), failures: new Map() }; scans.add(context); job = scheduler.scan(scan(message, context));
  } else if (message.action === 'references') job = scheduler.scan(references(message));
  else job = scheduler.submit(() => handle(message));
  job.then(result => parentPort.postMessage({ id: message.id, result }), error => parentPort.postMessage({ id: message.id, error: String(error.message || error) }));
});
