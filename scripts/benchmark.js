'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { CIndex } = require('../src/c-index');
const { highlightDocumentAsync } = require('../src/syntax');
const { TextSearchEngine } = require('../src/infrastructure/text-search-engine');

async function main() {
  const results = [];
  for (const count of [1000, 2000, 10000]) {
    global.gc?.(); const before = process.memoryUsage().heapUsed;
    const files = Array.from({ length: count }, (_, at) => ({ uri: `file:///benchmark/f${at}.h`, path: `/benchmark/f${at}.h`, project: 'benchmark',
      functions: [], declarations: [], symbols: [], macros: [], includes: at + 1 < count ? [{ name: `f${at + 1}.h`, quoted: true }] : [],
      calls: [{ caller: 'unresolved-benchmark', name: 'unknown', indirect: false,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } }] }));
    const index = new CIndex(), started = performance.now(); index.replace(files);
    const buildMs = performance.now() - started;
    for (let at = 0; at < Math.min(count, 64); at++) index.visible(files[at].uri);
    results.push({ scenario: 'include-chain-and-unknown-lookups', files: count, buildMs: Math.round(buildMs),
      heapGrowthMiB: Math.round((process.memoryUsage().heapUsed - before) / 1048576), closureEntries: index.closureEntries,
      closureBudget: index.maxClosureEntries, closureBudgetPassed: index.closureEntries <= index.maxClosureEntries });
  }
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const doc = { version: 1, languageId: 'c', lineAt: () => ({ text: 'int example(void) { return 42; } // comment' }) };
  let started = performance.now(); await highlightDocumentAsync(doc, 99960, 99999); delay.disable();
  results.push({ scenario: 'cold-syntax-100k-lines-last-40', elapsedMs: Math.round(performance.now() - started),
    eventLoopP95Ms: Math.round(delay.percentile(95) / 1000000) });
  const engine = new TextSearchEngine();
  try {
    const source = 'int example(void) { return 42; }\n'.repeat(100000);
    started = performance.now(); const rows = await engine.match(source, 'return', {}, 2000);
    results.push({ scenario: 'background-literal-search', bytes: Buffer.byteLength(source), matches: rows.length,
      limit: 2000, elapsedMs: Math.round(performance.now() - started) });
  } finally { engine.dispose(); }
  const report = { generatedAt: new Date().toISOString(), commit: process.env.SOURCEINSIGHT_READER_BENCHMARK_COMMIT || 'working-tree',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, memoryGiB: Math.round(os.totalmem() / 1073741824) },
    note: 'Synthetic scenarios measure implementation paths, not real-project semantic accuracy or a cross-platform SLO.', results };
  await fs.mkdir(path.join(__dirname, '../dist'), { recursive: true });
  await fs.writeFile(path.join(__dirname, '../dist/benchmark-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (results.some(result => result.closureBudgetPassed === false)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
