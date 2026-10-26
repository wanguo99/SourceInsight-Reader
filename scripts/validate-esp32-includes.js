'use strict';
// Read-only real-project regression through the facade, Worker and Context.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fakeVscode, loadWithVscode } = require('../test/fake-vscode');
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const excluded = new Set(['.git', '.cache', 'node_modules', 'build', 'dist', 'out', 'research']);
const targets = { 'wifi_manager.h': 'network', 'web_server.h': 'web', 'camera_service.h': 'camera',
  'storage_service.h': 'storage', 'recording_service.h': 'recording', 'monitor_web.h': 'monitor_web' };

async function main() {
  if (!option('--root') || !option('--cache') || !option('--output')) throw new Error('Usage: node scripts/validate-esp32-includes.js --root SOURCE --cache CACHE --output REPORT');
  const root = fs.realpathSync(option('--root')), cache = path.resolve(option('--cache')), output = path.resolve(option('--output'));
  const inside = file => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  if (inside(cache) || inside(output)) throw new Error('Validation outputs must stay outside the source project');
  fs.mkdirSync(cache, { recursive: true });
  const env = fakeVscode(), modules = new Map(), files = [], queue = [root], read = new Map();
  const open = uri => {
    const id = uri.toString(); if (env.documents.has(id)) return env.documents.get(id);
    if (!inside(uri.fsPath)) throw new Error('Document is outside the project');
    const text = fs.readFileSync(uri.fsPath, 'utf8'), document = env.document(path.relative(root, uri.fsPath), text);
    env.documents.delete(document.uri.toString()); document.uri = uri; document.languageId = /\.(?:c|h)$/i.test(uri.fsPath) ? 'c' : 'cpp';
    env.documents.set(id, document); read.set(uri.fsPath, crypto.createHash('sha256').update(fs.readFileSync(uri.fsPath)).digest('hex')); return document;
  };
  while (queue.length) for (const entry of fs.readdirSync(queue.pop(), { withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) queue.push(file);
    else if (entry.isFile() && /\.(?:c|h|cc|cpp|cxx|hpp|hh|hxx)$/i.test(entry.name)) files.push(env.api.Uri.file(file));
  }
  const folder = { uri: env.api.Uri.file(root), name: path.basename(root) };
  env.api.workspace.workspaceFolders = [folder]; env.api.workspace.findFiles = async () => files;
  env.api.workspace.openTextDocument = async uri => open(uri);
  env.api.workspace.asRelativePath = uri => path.relative(root, uri.fsPath);
  env.settings.set('sourceInsightReader.navigationBackend', 'auto'); env.settings.set('sourceInsightReader.cacheDirectory', cache);
  env.context.storageUri = env.api.Uri.file(path.join(cache, 'session'));
  const catalog = { roots: () => [folder], folder: () => folder, projectKey: () => folder.uri.toString(), scopeKey: () => folder.uri.toString(),
    list: async () => files, documents: () => [...env.documents.values()], document: uri => env.documents.get(uri.toString()),
    contains: uri => inside(uri.fsPath), accepts: uri => inside(uri.fsPath), onDidChange: () => new env.api.Disposable() };
  const load = name => loadWithVscode(require.resolve(name), env.api, modules), logs = [];
  const index = new (load('../src/local-index').LocalIndex)(env.context, catalog, message => logs.push(message));
  let definitionProvider;
  env.api.languages.registerDefinitionProvider = (_selector, provider) => { definitionProvider = provider; return new env.api.Disposable(); };
  const registration = load('../src/definition-provider').registerLocalDefinitions(index);
  const adapter = new (load('../src/language').LanguageAdapter)(index, catalog);
  const preview = new (load('../src/context').ContextView)({ contextDefinitions: (...args) => adapter.contextDefinitions(...args), allowed: uri => inside(uri.fsPath) }, () => {});
  const report = { root, sourceReadOnly: true, languageService: 'Empty provider responses; local fallback exercised independently', startedAt: new Date().toISOString(), cases: [], logs };
  try {
    const document = open(env.api.Uri.file(path.join(root, 'components/runtime/runtime.c')));
    await index.ensure(); report.summary = index.summary;
    for (const [name, component] of Object.entries(targets)) {
      const text = document.getText(), at = text.indexOf('"' + name + '"') + 1;
      if (!at) throw new Error('Include disappeared: ' + name);
      const position = new env.api.Position(text.slice(0, at).split('\n').length - 1, at - text.lastIndexOf('\n', at - 1) - 1);
      await preview.definition({ uri: document.uri, range: new env.api.Range(position, position) });
      const expected = path.join(root, 'components', component, 'include', name), actual = preview.current?.uri.fsPath;
      const links = await definitionProvider.provideDefinition(document, position, { isCancellationRequested: false });
      report.cases.push({ name, position, expected, actual, nativeTargets: links.map(value => value.targetUri.fsPath),
        originRanges: links.map(value => value.originSelectionRange), status: preview.state.status, passed: expected === actual && links.some(value => value.targetUri.fsPath === expected) });
    }
    await preview.definition({ uri: document.uri, range: new env.api.Range(3, 12, 3, 12) });
    report.missingHeaderStatus = preview.state.status;
    report.passed = report.cases.every(value => value.passed) && report.missingHeaderStatus.includes('sdkconfig.h') && !report.missingHeaderStatus.includes('esp_log.h');
    report.sourceHashes = Object.fromEntries([...read].map(([file, hash]) => [path.relative(root, file), hash]));
  } finally { registration.dispose(); preview.dispose(); adapter.dispose(); index.dispose(); await index.workerStopping; fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report.cases)); if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
