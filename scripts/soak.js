'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
async function main() {
  const seconds = Number(process.argv.find(value => value.startsWith('--seconds='))?.slice(10) || 60);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 43200) throw new Error('seconds must be between 1 and 43200');
  const restartEvery = Number(process.argv.find(value => value.startsWith('--restart-every='))?.slice(16) || 1000);
  if (!Number.isInteger(restartEvery) || restartEvery < 1 || restartEvery > 100000) throw new Error('Invalid restart interval');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-soak-')), report = { startedAt: new Date().toISOString(), requestedSeconds: seconds, restartEvery, completed: false, iterations: 0, restarts: 0, samples: [], failures: [] };
  const file = path.join(dir, 'sample.c'), cachePath = path.join(dir, 'facts.json'), uri = pathToFileURL(file).href;
  let worker, sequence = 0, stopping = false; const pending = new Map();
  process.once('SIGINT', () => { stopping = true; });
  const start = () => {
    worker = new Worker(path.join(__dirname, '../src/index-worker.js'));
    worker.on('message', message => {
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.result);
    });
    worker.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  };
  const request = (action, data = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('soak request timeout: ' + action)); }, 15000);
    pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...data });
  });
  const source = value => `int value = ${value};\nint leaf(void) { return value; }\nint caller(void) { return leaf(); }\n`;
  const scan = async () => request('scan', { files: [{ uri, path: file, project: 'soak' }], cachePath });
  const started = Date.now(), deadline = started + seconds * 1000;
  try {
    await fs.writeFile(file, source(0)); start(); await scan();
    while (!stopping && Date.now() < deadline) {
      await request('updateBatch', { files: [{ file: { uri, path: file, project: 'soak', text: source(report.iterations) }, dirty: true }] });
      const definitions = await request('definitions', { uri, position: { line: 2, character: 27 } });
      if (definitions.length !== 1 || definitions[0].name !== 'leaf') throw new Error('unexpected definition');
      const references = await request('references', { uri, position: { line: 0, character: 5 } });
      if (references.locations.length !== 2) throw new Error('unexpected references');
      if (report.iterations % restartEvery === 0) {
        await fs.writeFile(file, source(report.iterations)); await request('update', { file: { uri, path: file, project: 'soak' } }); await request('flush');
        await request('shutdown'); await worker.terminate(); report.restarts++;
        // Deliberately corrupt one cached snapshot; source remains authoritative.
        if (report.restarts % 3 === 0) await fs.writeFile(cachePath, '{broken');
        start(); await scan();
      }
      if (report.iterations % 50 === 0) report.samples.push({ elapsedMs: Date.now() - started, ...(await request('metrics')) });
      report.iterations++; await new Promise(resolve => setTimeout(resolve, 20));
    }
    report.completed = !stopping && Date.now() >= deadline;
  } catch (error) { report.failures.push(error.message); process.exitCode = 1; }
  finally {
    await worker?.terminate(); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('soak stopped')); } pending.clear();
    report.elapsedMs = Date.now() - started; report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.join(__dirname, '../dist'), { recursive: true }); await fs.writeFile(path.join(__dirname, '../dist/soak-results.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.rm(dir, { recursive: true, force: true }); console.log(JSON.stringify({ completed: report.completed, iterations: report.iterations, restarts: report.restarts, failures: report.failures }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
