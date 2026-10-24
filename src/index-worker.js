'use strict';
const { parentPort, workerData, resourceLimits } = require('node:worker_threads');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { createParser, parseC } = require('./c-parser');
const { CIndex } = require('./c-index');
const { relativeUriPath } = require('./resources');
const { WorkerScheduler } = require('./infrastructure/worker-scheduler');
const { JsonIndexRepository } = require('./infrastructure/index-repository');
const { decodeSource } = require('./infrastructure/source-text');
const { IndexMemory } = require('./infrastructure/index-memory');
const { failureKind } = require('./domain/index-diagnostics');
const memory = new IndexMemory(workerData?.memoryLimitMb || resourceLimits.maxOldGenerationSizeMb || 1024);
const index = new CIndex(), scheduler = new WorkerScheduler();
const parserId = require('../vendor/tree-sitter/manifest.json').map(asset => asset.sha256).join(':') + ':facts-9';
const repository = new JsonIndexRepository(parserId, error => parentPort.postMessage({ diagnostic: String(error.message || error) }));
let parser, scanEpoch = 0, fileFailures = new Map(), deferredFiles = 0; const scans = new Set();
const summary = () => ({ ...index.summary(), failures: [...fileFailures].map(([uri, message]) => ({ uri, message, kind: failureKind(message) })),
  memory: memory.snapshot(), ...(deferredFiles ? { memoryLimited: true, deferredFiles } : {}) });
const FULL_BYTES = 8 * 1024 * 1024, MAX_BYTES = 16 * 1024 * 1024;
async function parse(file, force = false) {
  const previous = repository.get(file.uri); let stamp;
  if (file.text === undefined) {
    const info = await fs.stat(file.path);
    if (info.size > MAX_BYTES) throw new Error('文件超过本地索引 16 MiB 硬限制');
    stamp = { size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, inode: String(info.ino), encoding: file.encoding || 'utf8' };
    if (!force && previous && JSON.stringify(previous.stamp) === JSON.stringify(stamp)) return { ...previous, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude };
  }
  const warnings = [];
  const source = file.text ?? decodeSource(await fs.readFile(file.path), file.encoding, message => warnings.push(message));
  const bytes = Buffer.byteLength(source);
  if (bytes > MAX_BYTES) throw new Error('文件超过本地索引 16 MiB 硬限制');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  if (previous?.hash === hash) return { ...previous, stamp, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude };
  memory.check(); parser ||= await createParser();
  return { ...parseC(parser, source, file.uri, file.path, () => memory.check(), { declarationsOnly: bytes > FULL_BYTES }),
    ...(warnings.length ? { warnings } : {}), stamp, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude };
}
async function* scan(message, context) {
  repository.pause();
  try {
    parentPort.postMessage({ progress: { id: message.id, done: 0, total: message.files.length } });
    if (message.force) index.replace([]);
    await repository.open(message.cachePath, message.force, { live: new Set(message.files.map(file => file.uri)), canLoad: () => memory.available(0.5),
      maxLineChars: Math.min(16 * 1024 * 1024, memory.limit / 64) });
    const next = new Map(), failures = new Map(); let count = 0, yielded = Date.now(), published = index.files.size > 0;
    deferredFiles = 0;
    for (const file of message.files) {
      if (context.epoch !== scanEpoch) return { cancelled: true };
      if (!repository.get(file.uri) && !memory.available()) { deferredFiles++; count++; continue; }
      try { const facts = await parse(file, message.force); next.set(file.uri, facts); if (file.text === undefined) repository.stage(facts); }
      catch (error) { if (error.code === 'INDEX_MEMORY_BUDGET') { deferredFiles++; repository.remove(file.uri); } else failures.set(file.uri, error.message); }
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
    return { ...summary(), ...(deferredFiles ? { indexedUris: [...next.keys()] } : {}) };
  } finally { scans.delete(context); repository.resume(); }
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
        if (error.code === 'INDEX_MEMORY_BUDGET') deferredFiles = Math.max(1, deferredFiles);
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
      if (error.code === 'INDEX_MEMORY_BUDGET') deferredFiles = Math.max(1, deferredFiles);
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
  if (message.action === 'issues') {
    /** @type {Array<{uri: string, message: string, kind: string, range?: import('./domain/contracts').Range, symbols?: number, functions?: number}>} */
    const issues = [...fileFailures].map(([uri, message]) => ({ uri, message, kind: failureKind(message) }));
    for (const file of index.files.values()) {
      if (file.declarationsOnly) issues.push({ uri: file.uri, kind: 'limited', message: '大文件已收录顶层定义/声明；函数体、局部变量与调用关系需要语言服务补充', symbols: file.symbols.length, functions: file.functions.length });
      if (file.hasErrors) issues.push({ uri: file.uri, kind: 'parseRecovery', range: file.parseIssues?.[0]?.range,
        message: '已收录可识别符号；宏、扩展语法或不完整声明需要语言服务复查', symbols: file.symbols.length, functions: file.functions.length });
      for (const warning of file.warnings || []) issues.push({ uri: file.uri, kind: 'warning', message: warning });
      if (issues.length >= 5000) break;
    }
    return issues.slice(0, 5000);
  }
  if (message.action === 'callDiagnostics') return [...index.callDiagnostics(message.item, message.direction), ...(deferredFiles ? [`内存预算限制：${deferredFiles} 个文件未收录，调用关系可能遗漏`] : [])];
  if (message.action === 'calls') return index.calls(message.item, message.direction);
  if (message.action === 'flush') { await repository.flush(); return {}; }
  if (message.action === 'metrics') return { heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, arrayBuffers: process.memoryUsage().arrayBuffers, files: index.files.size, closureEntries: index.closureEntries, ...memory.snapshot() };
  if (message.action === 'shutdown') { scanEpoch++; await repository.flush(); return {}; }
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
  return { locations, ...(deferredFiles ? { incomplete: true } : {}) };
}
parentPort.on('message', message => {
  let job;
  if (message.action === 'scan') {
    const context = { epoch: ++scanEpoch, overrides: new Map(), failures: new Map() }; scans.add(context); job = scheduler.scan(scan(message, context));
  } else if (message.action === 'references') job = scheduler.scan(references(message));
  else job = scheduler.submit(() => handle(message));
  job.then(result => {
    parentPort.postMessage({ id: message.id, result });
    if (message.action === 'shutdown') parentPort.close();
  }, error => parentPort.postMessage({ id: message.id, error: String(error.message || error) }));
});
