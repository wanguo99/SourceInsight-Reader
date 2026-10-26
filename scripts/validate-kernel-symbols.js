'use strict';
// Independent compiler oracle + production Worker queries. Never write sources.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { LspClient } = require('../test/lsp-client');
const { resourcePlan } = require('../src/infrastructure/index-resources');
const { databasePath } = require('../src/infrastructure/index-database');
const { semanticSpans } = require('../src/preview-colors');
const { exportReferences, correctExportTokens } = require('../src/infrastructure/c-export-references');
const { releaseWorkerLeases } = require('../src/infrastructure/cache-lease');
const { withoutTrivia, withoutDirectives } = require('../src/infrastructure/c-source-projection');
const { createHash } = require('node:crypto');
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const units = ['init/main.c', 'kernel/fork.c', 'kernel/sched/core.c', 'drivers/char/mem.c', 'include/linux/sched.h', 'include/linux/bpf.h', 'include/linux/types.h', 'include/linux/list.h'];
const positionKey = value => `${value.uri}:${value.selectionRange?.start.line ?? value.range.start.line}:${value.selectionRange?.start.character ?? value.range.start.character}`;
function category(span, line, target, declaration = '') {
  const modifiers = new Set(span.modifiers), local = modifiers.has('functionScope');
  const isStatic = modifiers.has('static') || /\bstatic\b/.test(declaration);
  if (['function', 'method'].includes(span.type)) return isStatic ? 'staticFunction' : 'function';
  if (span.type === 'parameter') return 'parameter';
  if (span.type === 'macro') return /^\(/.test(line.slice(target.character + span.name.length).replace(/\\\r?\n/g, '')) ? 'macroFunction' : 'macroObject';
  if (span.type === 'variable' && new RegExp('\\(\\s*\\*\\s*' + span.name + '\\b').test(line)) return local ? 'localFunctionPointer' : 'globalFunctionPointer';
  if (span.type === 'variable') return isStatic ? local ? 'staticLocal' : modifiers.has('readonly') ? 'staticConstant' : 'staticGlobal'
    : modifiers.has('readonly') ? local ? 'localConstant' : 'globalConstant' : local ? 'localVariable' : 'globalVariable';
  if (span.type === 'property') return /^\s*:/.test(line.slice(target.character + span.name.length)) ? 'bitField' : 'field';
  if (span.type === 'enumMember') return 'enumValue';
  if (span.type === 'enum') return 'enum';
  if (span.type === 'label') return 'label';
  if (span.type === 'type') return 'typedef';
  if (['class', 'struct', 'interface'].includes(span.type)) return /\bunion\s*$/.test(line.slice(0, target.character)) ? 'union' : 'struct';
}
async function validateAdapter(root, compdb, oracle, request) {
  const { fakeVscode, loadWithVscode } = require('../test/fake-vscode');
  const env = fakeVscode(), project = { uri: env.api.Uri.file(root), name: path.basename(root) };
  env.api.workspace.workspaceFolders = [project];
  const document = uri => {
    if (!env.documents.has(uri)) {
      const file = fileURLToPath(uri), value = env.document(path.relative(root, file), fs.readFileSync(file, 'utf8'));
      env.documents.delete(value.uri.toString()); value.uri = env.api.Uri.parse(uri); value.languageId = 'c'; env.documents.set(uri, value);
    }
    return env.documents.get(uri);
  };
  const inside = uri => { const relative = path.relative(root, uri.fsPath); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  const client = new LspClient(process.env.CLANGD_PATH || 'clangd', ['--compile-commands-dir=' + compdb, '--background-index=false', '--pch-storage=memory', '--clang-tidy=false', '-j=1'], root);
  const modules = new Map(), { LanguageAdapter } = loadWithVscode(require.resolve('../src/language'), env.api, modules), { ContextView } = loadWithVscode(require.resolve('../src/context'), env.api, modules);
  const range = value => new env.api.Range(value.start.line, value.start.character, value.end.line, value.end.character);
  const local = { enabled: () => true, supports: inside, log() {}, definitions: async (uri, position) => (await request('definitions', { uri: uri.toString(), position })).map(value => ({ uri: env.api.Uri.parse(value.uri), range: range(value.selectionRange) })) };
  const adapter = new LanguageAdapter(local, { accepts: inside, folder: () => project, document: uri => document(uri.toString()) });
  const preview = new ContextView({ contextDefinitions: (...args) => adapter.contextDefinitions(...args), allowed: inside }, () => {});
  const results = [];
  try {
    await client.request('initialize', { processId: process.pid, rootUri: project.uri.toString(), capabilities: {} }); client.notify('initialized', {});
    env.commands.set('vscode.executeDefinitionProvider', async (uri, position) => {
      const returned = await client.request('textDocument/definition', { textDocument: { uri: uri.toString() }, position });
      return (Array.isArray(returned) ? returned : returned ? [returned] : []).map(value => {
        const uri = value.targetUri || value.uri; document(uri);
        return { uri: env.api.Uri.parse(uri), range: range(value.targetSelectionRange || value.range || value.targetRange) };
      });
    });
    for (const unit of oracle.documents) {
      const uri = pathToFileURL(path.join(root, unit.file)).href, doc = document(uri);
      client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'c', version: 1, text: doc.getText() } });
      // Warm the native AST, as the editor does before a stable symbol query.
      await client.request('textDocument/documentSymbol', { textDocument: { uri } });
      for (const probe of oracle.cases.filter(value => value.file === unit.file)) {
        await preview.definition({ uri: doc.uri, range: range({ start: probe.position, end: probe.position }) });
        const locations = preview.candidates || [], keys = new Set(locations.map(value => positionKey({ ...value, uri: value.uri.toString() })));
        const matched = probe.expected.every(value => keys.has(positionKey(value)));
        const unresolvedSelection = locations.length > 1 && !preview.current;
        const selected = locations.length === 1 && preview.current?.uri.toString() === locations[0].uri.toString();
        results.push({ category: probe.category, uniqueness: probe.uniqueness, name: probe.name, file: probe.file, position: probe.position,
          provider: locations[0]?.provider, candidates: preview.state.candidates, passed: matched && (unresolvedSelection || selected) });
      }
    }
  } finally { preview.dispose(); adapter.dispose(); await client.close(); }
  return results;
}
async function main() {
  if (!option('--root') || !option('--cache') || !option('--output')) throw new Error('Usage: node scripts/validate-kernel-symbols.js --root SOURCE --cache CACHE --output REPORT [--compdb DIRECTORY] [--oracle FILE] [--oracle-only] [--adapter]');
  const root = fs.realpathSync(option('--root')), cache = path.resolve(option('--cache')), output = path.resolve(option('--output'));
  const underRoot = file => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  if (underRoot(cache) || underRoot(output)) throw new Error('Validation output must be outside the source tree');
  if ((!option('--oracle') || process.argv.includes('--adapter')) && !option('--compdb')) throw new Error('Compiler validation requires --compdb');
  const project = pathToFileURL(root).href, databaseFile = databasePath(cache, project), database = new DatabaseSync(databaseFile, { readOnly: true });
  const inside = uri => { try { const relative = path.relative(root, fileURLToPath(uri)); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); } catch { return false; } };
  const files = database.prepare('SELECT uri,path FROM files').all().map(value => ({ ...value, project }));
  const read = new Map(), texts = file => { if (!read.has(file)) read.set(file, fs.readFileSync(file, 'utf8')); return read.get(file); };
  const multiplicities = new Map();
  const multiplicity = (name, kind) => {
    const key = `${kind}:${name}`; if (multiplicities.has(key)) return multiplicities.get(key);
    let count;
    if (['function', 'staticFunction'].includes(kind)) count = database.prepare('SELECT count(*) n FROM functions WHERE name=?').get(name).n;
    else {
      const role = ['localVariable', 'localConstant', 'staticLocal', 'parameter', 'label', 'localFunctionPointer'].includes(kind) ? 'local' : ['field', 'bitField'].includes(kind) ? 'member'
        : ['struct', 'union', 'enum', 'enumValue', 'typedef'].includes(kind) ? undefined : 'top';
      const positions = new Set();
      const query = database.prepare("SELECT uri,line,col,data FROM symbols WHERE provider='local' AND name=?" + (role ? ' AND role=?' : ''));
      for (const row of query.iterate(...(role ? [name, role] : [name]))) {
        const node = JSON.parse(zlib.inflateRawSync(row.data).toString());
        const relevant = kind === 'label' ? node.category === 'label' : ['field', 'bitField'].includes(kind) ? node.kind === 7
          : ['macroObject', 'macroFunction'].includes(kind) ? node.category === 'macro'
          : kind === 'typedef' ? node.detail.startsWith('typedef') : kind === 'enumValue' ? node.kind === 21
          : kind === 'enum' ? node.namespace === 'tag' && node.detail === 'enum'
          : ['struct', 'union'].includes(kind) ? node.namespace === 'tag' && node.detail === kind : node.kind === 12 && !['macroParameter', 'label'].includes(node.category);
        if (relevant && !node.declarationOnly) positions.add(`${row.uri}:${row.line}:${row.col}`);
      }
      count = positions.size;
    }
    multiplicities.set(key, Number(count)); return Number(count);
  };
  let oracle;
  if (option('--oracle')) oracle = JSON.parse(fs.readFileSync(option('--oracle'), 'utf8'));
  else {
    oracle = { root, sourceReadOnly: true, compiler: 'clangd', cases: [], skippedExternal: 0, skippedUnresolved: 0, skippedSelfTargets: 0, documents: [] };
    const client = new LspClient(process.env.CLANGD_PATH || 'clangd', ['--compile-commands-dir=' + path.resolve(option('--compdb')), '--background-index=false', '--pch-storage=memory', '--clang-tidy=false', '-j=1'], root);
    const buckets = new Map(), seen = new Set(), quota = Number(option('--per-bucket') || 4);
    try {
      const initialized = await client.request('initialize', { processId: process.pid, rootUri: project, capabilities: { textDocument: { definition: { linkSupport: true }, semanticTokens: {
        requests: { full: true }, tokenTypes: ['variable', 'function', 'parameter', 'macro', 'type', 'class', 'enum', 'enumMember', 'property', 'label'],
        tokenModifiers: ['declaration', 'definition', 'readonly', 'static', 'functionScope', 'fileScope', 'globalScope'], formats: ['relative']
      } } } });
      oracle.server = initialized.serverInfo;
      client.notify('initialized', {});
      for (const relative of units) {
        const file = path.join(root, relative), source = texts(file), lines = source.split('\n'), uri = pathToFileURL(file).href;
        client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'c', version: 1, text: source } });
        const tokens = await client.request('textDocument/semanticTokens/full', { textDocument: { uri } });
        const spans = correctExportTokens(semanticSpans(initialized.capabilities.semanticTokensProvider.legend, tokens.data), exportReferences(source));
        let requests = 0;
        for (const span of spans) {
          if (requests >= 600) break;
          if (span.modifiers.some(value => ['declaration', 'definition', 'defaultLibrary'].includes(value))) continue;
          span.name = (lines[span.line] || '').slice(span.start, span.end);
          const provisional = category(span, '', { character: 0 }); if (!provisional || !/^[A-Za-z_$][\w$]*$/.test(span.name)) continue;
          const candidateKey = `${relative}:${provisional}:${span.name}`;
          if (seen.has(candidateKey)) continue; seen.add(candidateKey);
          const preliminaryCount = multiplicity(span.name, provisional), preliminary = `${provisional}:${preliminaryCount ? preliminaryCount > 1 ? 'duplicate' : 'unique' : 'unknown'}`;
          if ((buckets.get(preliminary) || 0) >= quota && !['function', 'variable', 'property', 'macro', 'class', 'struct', 'interface'].includes(span.type)) continue;
          requests++;
          const returned = await client.request('textDocument/definition', { textDocument: { uri }, position: { line: span.line, character: span.start } });
          const expected = (Array.isArray(returned) ? returned : returned ? [returned] : []).map(value => ({ uri: value.targetUri || value.uri, range: value.targetSelectionRange || value.range || value.targetRange }));
          if (!expected.length) { oracle.skippedUnresolved++; continue; }
          if (expected.every(value => value.uri === uri && value.range.start.line === span.line && value.range.start.character === span.start)) { oracle.skippedSelfTargets++; continue; }
          if (!expected.every(value => inside(value.uri))) { oracle.skippedExternal++; continue; }
          const target = expected[0], targetSource = texts(fileURLToPath(target.uri)), targetLines = targetSource.split('\n'), targetLine = targetLines[target.range.start.line] || '';
          const prefix = withoutDirectives(withoutTrivia(targetLines.slice(Math.max(0, target.range.start.line - 12), target.range.start.line).join('\n') + '\n' + targetLine.slice(0, target.range.start.character))).split(/[;{}]/).at(-1);
          const kind = category(span, targetLine, target.range.start, prefix), count = multiplicity(span.name, kind), uniqueness = count ? count > 1 ? 'duplicate' : 'unique' : 'unknown', bucket = `${kind}:${uniqueness}`;
          if ((buckets.get(bucket) || 0) >= quota) continue;
          buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
          oracle.cases.push({ category: kind, uniqueness, catalogDefinitions: count, name: span.name, file: relative, position: { line: span.line, character: span.start }, expected });
        }
        oracle.documents.push({ file: relative, tokens: spans.length, definitionRequests: requests });
        console.log(JSON.stringify({ oracle: relative, cases: oracle.cases.length, buckets: Object.fromEntries(buckets) }));
      }
    } finally { await client.close(); }
    oracle.sourceHashes = Object.fromEntries([...read.keys()].map(file => [path.relative(root, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  }
  for (const probe of oracle.cases) {
    probe.catalogDefinitions = multiplicity(probe.name, probe.category);
    probe.uniqueness = probe.catalogDefinitions ? probe.catalogDefinitions > 1 ? 'duplicate' : 'unique' : 'unknown';
    probe.catalogMultiplicityKnown = probe.catalogDefinitions > 0;
  }
  database.close();
  if (oracle.root !== root) throw new Error('Oracle belongs to a different project');
  for (const [relative, expected] of Object.entries(oracle.sourceHashes || {})) {
    const file = path.resolve(root, relative);
    if (!inside(pathToFileURL(file).href) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw new Error('Oracle source has changed: ' + relative);
  }
  if (!option('--oracle')) fs.writeFileSync(output + '.oracle.json', JSON.stringify(oracle, null, 2) + '\n');
  if (process.argv.includes('--oracle-only')) return;
  const plan = resourcePlan({ memoryMb: 1024 }), worker = new Worker(path.resolve(__dirname, '../src/index-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: plan.coordinatorMb }, workerData: { resourcePlan: plan, baselineRss: process.memoryUsage.rss() } });
  const owner = worker.threadId, pending = new Map(); let sequence = 0;
  const request = (action, data = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Index validation timeout: ' + action)); }, 3600000); pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, action, ...data }); });
  worker.on('message', message => { const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result); });
  worker.on('error', error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); });
  const report = { root, sourceReadOnly: true, oracle: option('--oracle') || output + '.oracle.json', cases: [], totals: {}, documents: oracle.documents };
  try {
    const scanStarted = Date.now();
    report.summary = await request('scan', { files, databaseDirectory: cache }); report.scanMs = Date.now() - scanStarted;
    report.metrics = await request('metrics');
    for (const probe of oracle.cases) {
      const started = Date.now(), targets = await request('definitions', { uri: pathToFileURL(path.join(root, probe.file)).href, position: probe.position });
      const actual = new Set(targets.map(positionKey)), expected = probe.expected.map(positionKey);
      const matched = expected.every(value => actual.has(value));
      const status = !targets.length ? 'missing' : !matched ? 'wrong' : targets.length > probe.expected.length ? 'ambiguous' : 'exact';
      const value = { ...probe, status, elapsedMs: Date.now() - started, targets }; report.cases.push(value);
      const key = `${probe.category}:${probe.uniqueness}`; report.totals[key] ||= { exact: 0, ambiguous: 0, missing: 0, wrong: 0 }; report.totals[key][status]++;
    }
    report.localPassed = report.cases.every(value => !['missing', 'wrong'].includes(value.status));
    if (process.argv.includes('--adapter')) report.adapter = await validateAdapter(root, path.resolve(option('--compdb')), oracle, request);
    report.passed = report.adapter ? report.adapter.every(value => value.passed) : report.localPassed;
    await request('shutdown');
  } finally { await worker.terminate(); await releaseWorkerLeases([cache], owner); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify({ cases: report.cases.length, totals: report.totals, passed: report.passed }));
  if (!report.passed) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { validateAdapter };
