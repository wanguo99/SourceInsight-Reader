'use strict';
const { parentPort, workerData, resourceLimits } = require('node:worker_threads');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { SourceParser } = require('./infrastructure/source-parser');
const { ParserPool } = require('./infrastructure/parser-pool');
const { resourcePlan, CpuBudget, ProcessCpuBudget, SharedMemoryBudget } = require('./infrastructure/index-resources');
const { CIndex } = require('./c-index');
const { relativeUriPath, uriKey } = require('./resources');
const { WorkerScheduler } = require('./infrastructure/worker-scheduler');
const { JsonIndexRepository } = require('./infrastructure/index-repository');
const { SqliteIndexRepository } = require('./infrastructure/sqlite-index-repository');
const { decodeSource, isCppHeader } = require('./infrastructure/source-text');
const { isDirectiveOnly } = require('./infrastructure/c-source-projection');
const { IndexMemory, IndexMemoryError } = require('./infrastructure/index-memory');
const { failureKind, collectIndexIssues } = require('./domain/index-diagnostics');
const plan = workerData?.resourcePlan || resourcePlan({ memoryMb: workerData?.memoryLimitMb || resourceLimits.maxOldGenerationSizeMb || 1024 });
const memory = new IndexMemory(plan.coordinatorMb), cpu = new CpuBudget(plan.cpuFraction);
const cpuShared = new SharedArrayBuffer(32); cpu.group = new ProcessCpuBudget(plan, cpuShared); cpu.group.delay();
const shared = new SharedArrayBuffer((plan.parsers + 1) * 4), baselineRss = workerData?.baselineRss ?? process.memoryUsage.rss();
const budget = new SharedMemoryBudget(plan, memory, shared, 0, baselineRss);
const localParser = new SourceParser(); let localParsing = Promise.resolve(), pool, fallback = false, peakParsers = 0, parserFallbacks = 0;
const check = () => { cpu.check(); memory.check(); if (plan.lowMemory || !budget.available()) throw new IndexMemoryError(); };
Object.assign(check, { suspendedMs: () => cpu.waitedWallMs });
let index = new CIndex(undefined, () => cpu.check()); const scheduler = new WorkerScheduler();
const { PARSER_ID: parserId } = require('./infrastructure/index-schema');
/** @type {any} */
let repository = new JsonIndexRepository(parserId, error => parentPort.postMessage({ diagnostic: String(error.message || error) }));
let dirtyUris = new Set();
let descriptors = new Map(), reusedFiles = 0, parsedFiles = 0, inheritedFiles = 0;
let scanEpoch = 0, fileFailures = new Map(), deferredFiles = 0; const scans = new Set();
function relationProgress(done, total) { for (const context of scans) if (context.epoch === scanEpoch) context.relations?.(done, total); }
index.onProgress = relationProgress;
const summary = () => ({ ...index.summary(), failures: [...fileFailures].map(([uri, message]) => ({ uri, message, kind: failureKind(message) })),
  memory: { ...memory.snapshot(), ...budget.snapshot() }, parallel: { cpuCount: plan.cpus, cpuLimitPercent: plan.cpuPercent, parserLimit: plan.parsers, peakParsers, parserFallbacks },
  database: repository.diagnostics?.(), reusedFiles, parsedFiles, inheritedFiles, ...(deferredFiles ? { memoryLimited: true, deferredFiles } : {}) });
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DIRECTIVE_BYTES = 32 * 1024 * 1024;
async function parseSyntax(task, parallel) {
  if (plan.parsers && !fallback && (parallel || pool?.workers.length)) {
    pool ||= new ParserPool(plan, shared, baselineRss, message => parentPort.postMessage({ diagnostic: message }), cpuShared);
    const group = pool;
    try { const result = await group.parse(task, !parallel); peakParsers = Math.max(peakParsers, group.peakActive); return result; }
    catch (error) {
      if (!group.disabled && !['INDEX_MEMORY_BUDGET', 'ERR_WORKER_OUT_OF_MEMORY', 'INDEX_PARSER_EXIT', 'INDEX_POOL_CLOSED'].includes(error.code)) throw error;
      if (!fallback) { fallback = true; parserFallbacks++; parentPort.postMessage({ diagnostic: `并行解析资源不足，释放解析线程并降级串行校验：${task.path} · ${error.message}` }); }
      peakParsers = Math.max(peakParsers, group.peakActive); await group.close();
    }
  }
  const result = localParsing.then(() => { check(); return localParser.parse(task, check); });
  localParsing = result.then(() => {}, () => {}); return result;
}
async function parse(file, force = false, parallel = false) {
  cpu.check();
  if (!file.project && repository.owner?.has(file.uri)) file = { ...file, project: repository.owner.get(file.uri) };
  const previous = repository.get(file.uri) || (!force && file.text === undefined ? repository.reusable?.(file) : undefined); let stamp;
  if (file.text === undefined) {
    const info = await fs.stat(file.path);
    if (info.size > MAX_DIRECTIVE_BYTES) throw new Error('文件超过本地索引 32 MiB 读取上限');
    stamp = { size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, inode: String(info.ino), encoding: file.encoding || 'utf8' };
    if (!force && previous && !previous._inherited && JSON.stringify(previous.stamp) === JSON.stringify(stamp)) { reusedFiles++; return repository.bind ? repository.bind(previous, file) : { ...previous, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude }; }
  }
  const warnings = [];
  const source = file.text ?? decodeSource(await fs.readFile(file.path), file.encoding, message => warnings.push(message));
  const bytes = Buffer.byteLength(source);
  if (bytes > MAX_DIRECTIVE_BYTES) throw new Error('文件超过本地索引 32 MiB 读取上限');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  if (!force && previous?.hash === hash) { reusedFiles++; if (previous._inherited) inheritedFiles++; return repository.bind ? repository.bind(previous, file, stamp) : { ...previous, stamp, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude }; }
  parsedFiles++; check();
  if (bytes >= 128 * 1024 && repository.isSqlite && !/\.(?:cc|cpp|cxx|c\+\+|hpp|hh|hxx)$/i.test(file.path) && isDirectiveOnly(source) && !isCppHeader(source, file.path)) {
    if (!file.dirty) return { uri: file.uri, path: file.path, hash, stamp, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude,
      _directiveSource: source, parseIssues: [], ...(warnings.length ? { warnings } : {}) };
    if (bytes > 2 * 1024 * 1024) throw new IndexMemoryError();
  }
  if (bytes > MAX_BYTES) throw new Error('非纯预处理文件超过本地索引 16 MiB 硬限制');
  const facts = await parseSyntax({ source, uri: file.uri, path: file.path, bytes }, parallel);
  return { ...facts,
    ...(warnings.length ? { warnings } : {}), stamp, project: file.project, scopeKey: file.scopeKey, indexExclude: file.indexExclude };
}
async function* scan(message, context) {
  context.done = 0;
  const heartbeat = () => parentPort.postMessage({ progress: { id: message.id, stage: context.stage || 'files',
    done: context.stage === 'relations' ? context.relationDone : context.done, total: context.stage === 'relations' ? context.relationTotal : message.files.length } });
  context.relations = (done, total) => { context.stage = 'relations'; context.relationDone = done; context.relationTotal = total; if (!done || done === total) heartbeat(); };
  const timer = setInterval(heartbeat, 5000); timer.unref(); cpu.heartbeat = heartbeat;
  if (message.databaseDirectory && !repository.isSqlite) {
    repository = new SqliteIndexRepository(message.databaseDirectory, parserId, message => parentPort.postMessage({ diagnostic: String(message) }));
    index = new CIndex(repository, () => cpu.check(), relationProgress);
  }
  dirtyUris = new Set(message.files.filter(file => file.dirty).map(file => file.uri));
  descriptors = new Map(message.files.map(file => [file.uri, file])); reusedFiles = 0; parsedFiles = 0; inheritedFiles = 0;
  repository.pause(); fallback = false; peakParsers = 0; parserFallbacks = 0;
  const inflight = new Map();
  const parallel = plan.parsers > 0 && message.files.length >= 32;
  const width = parallel ? plan.parsers : 1;
  const prefetch = offset => {
    for (let at = offset; at < Math.min(message.files.length, offset + width); at++) if (!inflight.has(at)) {
      const file = message.files[at], task = { ready: undefined, result: undefined, error: undefined };
      task.ready = Promise.resolve().then(async () => {
        if (!repository.get(file.uri)) {
          if (!memory.available()) repository.trimCaches?.();
          if (plan.lowMemory || !memory.available(0.82) || !budget.available()) throw new IndexMemoryError();
        }
        return parse(file, message.force, parallel);
      }).then(result => { task.result = result; }, error => { task.error = error; });
      inflight.set(at, task);
    }
  };
  try {
    parentPort.postMessage({ progress: { id: message.id, done: 0, total: message.files.length } });
    if (message.force) index.replace([]);
    await repository.open(message.cachePath, message.force, { live: new Set(message.files.map(file => file.uri)), canLoad: () => { cpu.check(); return memory.available(); },
      maxLineChars: Math.min(16 * 1024 * 1024, memory.limit / 64), descriptors: message.files });
    const next = new Map(), failures = new Map(), deferred = []; let count = 0, yielded = Date.now(), published = index.files.size > 0;
    deferredFiles = 0;
    if (repository.isSqlite && !message.force && repository.files.size) {
      index.replace([...repository.files.values()]); published = true;
      context.stage = 'files';
      parentPort.postMessage({ snapshot: { scopeKey: message.scopeKey, indexExclude: message.indexExclude, uris: [...repository.files.keys()], summary: { ...summary(), fromDatabase: true } } });
    }
    for (let at = 0; at < message.files.length; at++) {
      const file = message.files[at];
      if (context.epoch !== scanEpoch) return { cancelled: true };
      prefetch(at); const task = inflight.get(at);
      yield { wait: task.ready };
      if (context.epoch !== scanEpoch) return { cancelled: true };
      inflight.delete(at);
      // A save/edit/delete received after dispatch owns this URI. Never let a
      // delayed parse replace its newer facts, even temporarily on disk.
      if (!context.overrides.has(file.uri)) {
        try {
          if (task.error) throw task.error; const facts = task.result;
          if (file.text === undefined || file.dirty === false) repository.stage(facts, check); else repository.overlay?.(facts);
          next.set(file.uri, repository.isSqlite && !file.dirty ? repository.get(file.uri) || facts : facts);
        } catch (error) {
          if (error.code === 'INDEX_MEMORY_BUDGET') { deferredFiles++; deferred.push(file); repository.remove(file.uri); repository.state?.(file, 'budget', error.message); }
          else { failures.set(file.uri, error.message); repository.remove(file.uri, true); repository.state?.(file, failureKind(error.message), error.message); }
        }
      }
      cpu.check();
      count++;
      context.done = count;
      if (!published && count >= 16 && count < message.files.length) {
        const partial = new Map(next);
        for (const [uri, facts] of context.overrides) {
          if (!facts) partial.delete(uri);
          else if ((message.scopeKey === undefined || facts.scopeKey === message.scopeKey) && (message.indexExclude === undefined || facts.indexExclude === message.indexExclude)) partial.set(uri, facts);
        }
        index.replace([...partial.values()]); context.stage = 'files'; fileFailures = new Map(failures); published = true;
        parentPort.postMessage({ snapshot: { scopeKey: message.scopeKey, indexExclude: message.indexExclude, uris: [...partial.keys()], summary: summary() } });
      }
      if (count % 16 === 0 || Date.now() - yielded > 20) { yielded = Date.now(); context.stage = 'files'; heartbeat(); yield; }
    }
    if (context.epoch !== scanEpoch) return { cancelled: true };
    if (deferred.length) {
      // Retry transient pressure once after releasing the parser isolates and
      // all disposable facts. Persistent limits remain explicit partial results.
      if (pool) { peakParsers = Math.max(peakParsers, pool.peakActive); await pool.close(); pool = undefined; }
      fallback = true; repository.trimCaches?.();
      for (const file of deferred) {
        if (context.epoch !== scanEpoch) return { cancelled: true };
        if (context.overrides.has(file.uri)) { deferredFiles--; continue; }
        try {
          let facts, failure;
          const ready = parse(file, true, false).then(value => { facts = value; }, error => { failure = error; });
          yield { wait: ready };
          if (context.epoch !== scanEpoch) return { cancelled: true };
          if (context.overrides.has(file.uri)) { deferredFiles--; continue; }
          if (failure) throw failure;
          if (file.text === undefined || file.dirty === false) repository.stage(facts, check); else repository.overlay?.(facts);
          next.set(file.uri, repository.isSqlite && !file.dirty ? repository.get(file.uri) || facts : facts); deferredFiles--;
        } catch (error) {
          if (error.code !== 'INDEX_MEMORY_BUDGET') { deferredFiles--; failures.set(file.uri, error.message); repository.state?.(file, failureKind(error.message), error.message); }
        }
        yield;
      }
    }
    for (const [uri, facts] of context.overrides) {
      if (!facts) {
        next.delete(uri);
        if (context.failures.has(uri)) failures.set(uri, context.failures.get(uri)); else failures.delete(uri);
      }
      else if (message.scopeKey !== undefined && facts.scopeKey !== message.scopeKey) continue;
      else if (message.indexExclude !== undefined && facts.indexExclude !== message.indexExclude) continue;
      else if (message.scopeRoots) {
        const root = [...message.scopeRoots].sort((a, b) => b.uri.length - a.uri.length).find(root => relativeUriPath(root.uri, facts.uri) !== undefined);
        if (root) { next.set(uri, repository.bind && facts._metadata ? repository.bind(facts, { ...facts._metadata, project: root.project }) : { ...facts, project: root.project }); failures.delete(uri); }
      } else { next.set(uri, facts); failures.delete(uri); }
    }
    if (pool) { peakParsers = Math.max(peakParsers, pool.peakActive); await pool.close(); pool = undefined; }
    repository.prune(new Set(message.files.map(file => file.uri))); index.replace([...next.values()]); fileFailures = failures;
    // First snapshot is available before persistence. Flushing is independent of queries.
    return { ...summary(), ...(deferredFiles ? { indexedUris: [...next.keys()] } : {}) };
  } finally {
    await Promise.allSettled([...inflight.values()].map(task => task.ready));
    if (pool) { peakParsers = Math.max(peakParsers, pool.peakActive); await pool.close(); pool = undefined; }
    scans.delete(context); repository.finishReuse?.(); repository.resume();
    clearInterval(timer); cpu.heartbeat = undefined;
  }
}
async function validateFile(uri) {
  const descriptor = descriptors.get(uri); if (!descriptor || dirtyUris.has(uri)) return;
  try {
    const old = repository.get(uri), value = await parse(descriptor);
    if (!old || old.hash !== value.hash || JSON.stringify(old.stamp) !== JSON.stringify(value.stamp)) {
      repository.stage(value, check); const current = repository.get(uri); index.update(current);
      for (const active of scans) active.overrides.set(uri, current);
    }
    fileFailures.delete(uri);
    for (const active of scans) active.failures.delete(uri);
  } catch (error) { fileFailures.set(uri, error.message); repository.remove(uri, true); repository.state?.(descriptor, failureKind(error.message), error.message); index.remove(uri); }
}
function failedUpdate(file, dirty, error) {
  if (!repository.isSqlite) return;
  if (dirty) repository.overlay({ ...file, symbols: [], locals: [], calls: [] });
  else { repository.remove(file.uri, true); repository.state(file, failureKind(error.message), error.message); }
}
async function handle(message) {
  if (message.action === 'cancelScan') { scanEpoch++; return { cancelled: true }; }
  if (message.action === 'updateBatch') {
    const next = new Map(index.files);
    for (const entry of message.files) {
      const uri = entry.file.uri;
      descriptors.set(uri, { ...entry.file, text: undefined });
      if (entry.dirty) dirtyUris.add(uri); else dirtyUris.delete(uri);
      try {
        if (entry.remove) {
          next.delete(uri); repository.remove(uri); fileFailures.delete(uri);
          for (const active of scans) { active.overrides.set(uri, undefined); active.failures.delete(uri); }
        } else {
          const facts = await parse(entry.file, true); fileFailures.delete(uri);
          if (!entry.dirty) { dirtyUris.delete(uri); repository.stage(facts, check); }
          else { dirtyUris.add(uri); repository.overlay?.(facts); }
          next.set(uri, repository.isSqlite && !entry.dirty ? repository.get(uri) || facts : facts);
          for (const active of scans) { active.overrides.set(uri, facts); active.failures.delete(uri); }
        }
      } catch (error) {
        failedUpdate(entry.file, entry.dirty, error);
        next.delete(uri); fileFailures.set(uri, error.message);
        if (error.code === 'INDEX_MEMORY_BUDGET') deferredFiles = Math.max(1, deferredFiles);
        for (const active of scans) { active.overrides.set(uri, undefined); active.failures.set(uri, error.message); }
      }
    }
    index.replace([...next.values()]); return summary();
  }
  if (message.action === 'update') {
    const uri = message.file.uri;
    descriptors.set(uri, { ...message.file, text: undefined });
    if (message.dirty) dirtyUris.add(uri); else dirtyUris.delete(uri);
    try {
      const facts = await parse(message.file, true); fileFailures.delete(uri);
      if (!message.dirty) { dirtyUris.delete(uri); repository.stage(facts, check); }
      else { dirtyUris.add(uri); repository.overlay?.(facts); }
      const current = repository.isSqlite && !message.dirty ? repository.get(uri) || facts : facts; index.update(current);
      for (const active of scans) { active.overrides.set(uri, current); active.failures.delete(uri); }
    } catch (error) {
      failedUpdate(message.file, message.dirty, error);
      fileFailures.set(uri, error.message); index.remove(uri);
      if (error.code === 'INDEX_MEMORY_BUDGET') deferredFiles = Math.max(1, deferredFiles);
      for (const active of scans) { active.overrides.set(uri, undefined); active.failures.set(uri, error.message); }
    }
    return summary();
  }
  if (message.action === 'remove') {
    for (const active of scans) { active.overrides.set(message.uri, undefined); active.failures.delete(message.uri); }
    dirtyUris.delete(message.uri); descriptors.delete(message.uri); repository.remove(message.uri); index.remove(message.uri); fileFailures.delete(message.uri); return summary();
  }
  if (repository.isSqlite && ['prepare','definitions','includeDefinitions','symbols','references'].includes(message.action) && message.uri) await validateFile(message.uri);
  if (message.action === 'prepare') return index.prepare(message.uri, message.position, message.name).map(fn => index.item(fn));
  if (message.action === 'definitions') { const values = index.definitions(message.uri, message.position); if (repository.isSqlite) for (const uri of new Set(values.map(value => value.uri))) await validateFile(uri); return index.definitions(message.uri, message.position); }
  if (message.action === 'includeDefinitions') {
    const values = index.includeDefinitions(message.uri, message.include);
    if (repository.isSqlite) for (const uri of new Set(values.map(value => value.uri))) await validateFile(uri);
    return index.includeDefinitions(message.uri, message.include);
  }
  if (message.action === 'includeRelations') return index.includeRelations(message.uri, message.incoming);
  if (message.action === 'explain') { await validateFile(message.uri); return index.explain(message.uri, message.position); }
  if (message.action === 'workspaceSymbols') return index.workspaceSymbols(message.query);
  if (message.action === 'symbols') {
    const symbols = index.symbols(message.uri), file = repository.get(message.uri), limit = file?.symbolListLimited || (file?.symbolCount > 5000 ? 5000 : 0);
    return limit ? Object.assign([...symbols], { sourceInsightReaderNote: `全部符号已写入索引；当前文件列表显示前 ${limit} 项，其余可用全局符号搜索或定义导航` }) : symbols;
  }
  if (message.action === 'issues') {
    const budgetUris = deferredFiles && !scans.size ? [...descriptors.keys()].filter(uri =>
      !index.files.has(uriKey({ toString: () => uri })) && !fileFailures.has(uri)) : [];
    return collectIndexIssues(index.files.values(), fileFailures, budgetUris);
  }
  if (message.action === 'callDiagnostics') return [...index.callDiagnostics(message.item, message.direction), ...(deferredFiles ? [`内存预算限制：${deferredFiles} 个文件未收录，调用关系可能遗漏`] : [])];
  if (message.action === 'calls') return index.calls(message.item, message.direction);
  if (message.action === 'flush') { await repository.flush(); return {}; }
  if (message.action === 'metrics') return { heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, arrayBuffers: process.memoryUsage().arrayBuffers, files: index.files.size, closureEntries: index.closureEntries, database: repository.diagnostics?.(), ...memory.snapshot(), ...budget.snapshot(), parallel: summary().parallel };
  if (message.action === 'shutdown') { scanEpoch++; if (pool) await pool.close(); await repository.flush(); repository.close?.(); localParser.close(); return {}; }
  throw new Error(`Unknown C index request: ${message.action}`);
}
async function* references(message) {
  if (repository.isSqlite) await validateFile(message.uri);
  const generation = index.generation, deadline = Date.now() + 3000, locations = []; let checked = 0;
  if (index.definitions(message.uri, message.position).length !== 1) return { locations, ambiguous: true };
  for (const location of index.referenceSites(message.uri, message.position)) {
    if (index.generation !== generation) throw new Error('源码索引已变化，请刷新引用');
    if (location) locations.push(location);
    if (locations.length >= 20000 || Date.now() > deadline) return { locations, incomplete: true };
    if (++checked % 64 === 0) { cpu.check(); yield; }
  }
  return { locations, ...(deferredFiles ? { incomplete: true } : {}) };
}
parentPort.on('message', message => {
  let job;
  if (message.action === 'scan') {
    const context = { epoch: ++scanEpoch, overrides: new Map(), failures: new Map() }; scans.add(context); job = scheduler.scan(scan(message, context));
  } else if (message.action === 'references') job = scheduler.scan(references(message));
  else job = scheduler.submit(async () => {
    try { const result = await handle(message); cpu.check(); return result; }
    catch (error) {
      const descriptor = descriptors.get(message.uri);
      if (error.code !== 'INDEX_CACHE_RECORD' || !descriptor || dirtyUris.has(message.uri)) throw error;
      repository.remove(message.uri, true);
      const facts = await parse(descriptor, true); repository.stage(facts, check); index.update(repository.get(message.uri));
      parentPort.postMessage({ diagnostic: `单文件缓存损坏已重新解析：${message.uri}` }); return handle(message);
    }
  });
  job.then(result => {
    parentPort.postMessage({ id: message.id, result });
    if (message.action === 'shutdown') parentPort.close();
  }, error => parentPort.postMessage({ id: message.id, error: String(error.message || error) }));
});
