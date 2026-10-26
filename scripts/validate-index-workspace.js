'use strict';
// Real-source validation through the production index worker. Sources are read
// only; all database/report output stays in the explicitly selected cache path.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const { resourcePlan, canResumeBudget } = require('../src/infrastructure/index-resources');
const { databasePath } = require('../src/infrastructure/index-database');
const { withoutTrivia } = require('../src/infrastructure/c-source-projection');
const { releaseWorkerLeases } = require('../src/infrastructure/cache-lease');
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const excluded = new Set(['.git', '.cache', 'node_modules', 'build', 'dist', 'out', 'research']);
function enumerate(root) {
  const result = [], queue = [root];
  while (queue.length) {
    const folder = queue.pop();
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory() && !excluded.has(entry.name)) queue.push(file);
      else if (/\.(?:c|h|cc|cpp|cxx|hpp|hh|hxx)$/i.test(entry.name)) {
        if (entry.isFile()) result.push(file);
        else if (entry.isSymbolicLink()) {
          const target = fs.realpathSync(file), relative = path.relative(root, target);
          if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && fs.statSync(target).isFile()) result.push(file);
        }
      }
    }
  }
  return result.sort();
}
function position(source, needle, offset = 0) {
  const at = withoutTrivia(source).indexOf(needle); if (at < 0) throw new Error('Probe text missing: ' + needle);
  const index = at + offset;
  return { line: source.slice(0, index).split('\n').length - 1, character: index - source.lastIndexOf('\n', index - 1) - 1 };
}
async function main(attempt = 0, attempts = []) {
  if (!option('--root') || !option('--cache') || !option('--output')) throw new Error('Usage: node scripts/validate-index-workspace.js --root SOURCE --cache CACHE --output REPORT [--probes JSON] [--force]');
  const root = fs.realpathSync(option('--root')), cache = path.resolve(option('--cache')), output = path.resolve(option('--output'));
  const contains = file => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  if (contains(cache) || contains(output)) throw new Error('Validation output must be outside the source tree');
  const project = pathToFileURL(root).toString(), started = Date.now(), plan = resourcePlan({ memoryMb: Number(option('--memory-mb') || 1024) });
  const files = enumerate(root).map(file => ({ uri: pathToFileURL(file).toString(), path: file, project }));
  const report = { sourceReadOnly: true, root, candidates: files.length, cache, database: databasePath(cache, project), parser: require('../src/infrastructure/index-schema').PARSER_ID, plan, attempts, snapshots: [], diagnostics: [], samples: [] };
  const baselineRss = process.memoryUsage.rss(), cpuStart = process.cpuUsage();
  const worker = new Worker(path.join(__dirname, '../src/index-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: plan.coordinatorMb }, workerData: { resourcePlan: plan, baselineRss } });
  const ownerThread = worker.threadId;
  let sequence = 0, lastProgress = 0; const pending = new Map();
  const request = (action, args = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); worker.postMessage({ id, action, ...args }); });
  const fail = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  worker.on('error', fail); worker.on('exit', code => fail(new Error('Worker exited: ' + code)));
  worker.on('message', message => {
    if (message.diagnostic) report.diagnostics.push(message.diagnostic);
    if (message.snapshot) report.snapshots.push({ elapsedMs: Date.now() - started, files: message.snapshot.summary.files, fromDatabase: Boolean(message.snapshot.summary.fromDatabase) });
    if (message.progress && Date.now() - lastProgress > 20000) { lastProgress = Date.now(); console.log(JSON.stringify({ progress: message.progress, rssMb: Math.round(process.memoryUsage.rss() / 1048576) })); }
    const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
  });
  let lastMetrics = 0, measuring = false; report.memorySnapshots = [];
  const timer = setInterval(() => {
    report.samples.push({ elapsedMs: Date.now() - started, rssMb: Math.round(process.memoryUsage.rss() / 1048576) });
    if (!measuring && Date.now() - lastMetrics >= 20000) {
      measuring = true; lastMetrics = Date.now();
      void request('metrics').then(metrics => {
        const snapshot = { elapsedMs: Date.now() - started, heapUsedMb: metrics.heapUsedMb, managedUsedMb: metrics.managedUsedMb, rssGrowthMb: metrics.rssGrowthMb, cachedFiles: metrics.database?.cachedFiles };
        report.memorySnapshots.push(snapshot); console.log(JSON.stringify({ memory: snapshot }));
      }, () => {}).finally(() => { measuring = false; });
    }
  }, 1000);
  const timeout = setTimeout(() => { fail(new Error('Validation exceeded one hour')); void worker.terminate(); }, 3600000);
  try {
    report.summary = await request('scan', { files, databaseDirectory: cache, force: process.argv.includes('--force') });
    if (report.summary.memoryLimited || report.summary.failures?.length || report.summary.files !== files.length) process.exitCode = 1;
    report.scanMs = Date.now() - started; report.metrics = await request('metrics'); report.issues = await request('issues'); report.probes = [];
    for (const probe of option('--probes') ? JSON.parse(fs.readFileSync(option('--probes'), 'utf8')) : []) {
      const file = path.resolve(root, probe.file), relative = path.relative(root, file);
      if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Probe is outside the source root');
      const source = fs.readFileSync(file, 'utf8'), point = position(source, probe.needle, probe.offset), time = Date.now();
      const targets = await request('definitions', { uri: pathToFileURL(file).toString(), position: point });
      const result = { ...probe, position: point, elapsedMs: Date.now() - time, targets };
      if (probe.expected) {
        const expectedFile = path.resolve(root, probe.expected.file);
        if (!contains(expectedFile)) throw new Error('Expected target is outside the source root');
        const expected = position(fs.readFileSync(expectedFile, 'utf8'), probe.expected.needle, probe.expected.offset);
        result.passed = targets.some(target => target.uri === pathToFileURL(expectedFile).toString() && target.selectionRange.start.line === expected.line && target.selectionRange.start.character === expected.character);
        if (!result.passed) process.exitCode = 1;
      }
      report.probes.push(result);
    }
    await request('shutdown'); report.completed = true;
  } catch (error) { report.completed = false; report.error = error.stack; process.exitCode = 1; }
  finally {
    clearInterval(timer); clearTimeout(timeout); await worker.terminate(); await releaseWorkerLeases([cache], ownerThread);
    const cpu = process.cpuUsage(cpuStart); Object.assign(report, { elapsedMs: Date.now() - started, peakRssMb: Math.max(0, ...report.samples.map(sample => sample.rssMb)), cpuCoreSeconds: (cpu.user + cpu.system) / 1e6 });
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ completed: report.completed, candidates: files.length, summary: { ...report.summary, indexedUris: undefined }, elapsedMs: report.elapsedMs, error: report.error }));
  }
  if (report.completed && canResumeBudget(report.summary, attempt > 0)) {
    fs.copyFileSync(output, output + '.attempt-1.json');
    const summary = { ...report.summary }; delete summary.indexedUris;
    console.log(JSON.stringify({ recovery: 'fresh-worker', deferredFiles: summary.deferredFiles, cachedFiles: summary.files }));
    process.exitCode = 0;
    return main(attempt + 1, [{ summary, elapsedMs: report.elapsedMs, peakRssMb: report.peakRssMb, scanMs: report.scanMs }]);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
