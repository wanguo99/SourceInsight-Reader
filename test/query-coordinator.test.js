'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { QueryCoordinator } = require('../src/infrastructure/query-coordinator');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const { RelationBackend } = require('../src/relation-backend');
const { queryResult, symbol } = require('../src/domain/model');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('query deadlines retain real work slots and identical requests coalesce', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const coordinator = new QueryCoordinator({ limit: 1 }); t.after(() => coordinator.dispose());
  let finish, started = 0;
  const first = coordinator.run('a', () => { started++; return new Promise(resolve => { finish = resolve; }); }, { timeout: 100 });
  const duplicate = coordinator.run('a', () => { throw new Error('duplicate started'); });
  assert.equal(first, duplicate);
  const rejected = assert.rejects(first, error => error.code === 'timeout');
  await tick(); t.mock.timers.tick(100); await rejected;
  await assert.rejects(coordinator.run('b', async () => []), error => error.code === 'busy');
  assert.equal(started, 1); assert.equal(coordinator.snapshot().active, 1);
  finish([]); await tick();
  assert.deepEqual(await coordinator.run('b', async () => [1]), [1]);
  assert.equal(coordinator.snapshot().active, 0);
});

test('invalidation cancels waiters, prevents stale reuse and keeps semantic/local budgets independent', async t => {
  const coordinator = new QueryCoordinator({ limit: 1 }); t.after(() => coordinator.dispose());
  let finish;
  const first = coordinator.run('a', () => new Promise(resolve => { finish = resolve; }));
  const rejected = assert.rejects(first, error => error.code === 'cancelled'); await tick();
  coordinator.invalidate(); await rejected;
  await assert.rejects(coordinator.run('a', async () => []), error => error.code === 'busy');
  assert.deepEqual(await coordinator.run('a', async () => ['local'], { channel: 'local' }), ['local']);
  finish(['old']); await tick();
  assert.deepEqual(await coordinator.run('a', async () => ['new']), ['new']);
  coordinator.dispose(); await assert.rejects(coordinator.run('a', async () => []), /结束/);
});

test('automatic definitions prefer semantic results, explicit local mode preserves offline reading', async t => {
  const env = fakeVscode(), doc = env.document('main.c');
  const { LanguageAdapter } = loadWithVscode(require.resolve('../src/language'), env.api);
  const semantic = { uri: doc.uri, range: new env.api.Range(1, 0, 1, 3) };
  let localQueries = 0;
  const adapter = new LanguageAdapter({ enabled: () => true, supports: () => true, log() {},
    definitions: async () => { localQueries++; return [{ uri: doc.uri, range: new env.api.Range(0, 0, 0, 3) }]; } });
  t.after(() => adapter.dispose());
  env.commands.set('vscode.executeDefinitionProvider', async () => [semantic]);
  let result = await adapter.contextDefinitions(doc.uri, new env.api.Position(0, 0));
  assert.equal(result.locations[0].range, semantic.range); assert.equal(result.provider, 'languageService'); assert.equal(localQueries, 0);
  env.settings.set('sourceInsightReader.navigationBackend', 'local');
  result = await adapter.contextDefinitions(doc.uri, new env.api.Position(0, 0));
  assert.equal(result.locations[0].range.start.line, 0); assert.equal(result.provider, 'local'); assert.match(result.note, /语法索引/);
});

test('non-C symbols, definitions and references finish on permanently stalled providers', async t => {
  const env = fakeVscode(), doc = env.document('app.py'); doc.languageId = 'python';
  env.settings.set('sourceInsightReader.queryTimeoutMs', 100);
  env.settings.set('sourceInsightReader.navigationBackend', 'languageService');
  const { LanguageAdapter } = loadWithVscode(require.resolve('../src/language'), env.api);
  const adapter = new LanguageAdapter(); t.after(() => adapter.dispose());
  for (const command of ['vscode.executeDocumentSymbolProvider', 'vscode.executeDefinitionProvider', 'vscode.executeReferenceProvider']) env.commands.set(command, () => new Promise(() => {}));
  await Promise.all([
    assert.rejects(adapter.symbols(doc.uri), /超时/),
    assert.rejects(adapter.definitions(doc.uri, new env.api.Position(0, 0)), /超时/),
    assert.rejects(adapter.references(doc.uri, new env.api.Position(0, 0)), /超时/)
  ]);
  assert.equal(adapter.queries.snapshot().timeouts, 3);
});

test('automatic relation empty local data never suppresses a semantic result', async t => {
  const root = symbol({ name: 'root', uri: 'file:///project/a.c', selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } });
  const local = { id: 'local', revision: () => '1', invalidate() {}, supports: () => true, describe: () => ({ state: 'ready', note: '' }),
    prepare: async () => queryResult([root], 'local', 'ready'), calls: async () => queryResult([], 'local', 'empty') };
  const semantic = { ...local, id: 'languageService', prepare: async () => queryResult([root], 'languageService', 'ready'),
    calls: async () => queryResult([{ symbol: root, sites: [] }], 'languageService', 'ready') };
  const engine = new RelationBackend({ local, semantic, settings: (key, fallback) => fallback, scope: () => 'root' }); t.after(() => engine.dispose());
  assert.equal((await engine.prepare(root.location)).provider, 'languageService');
  assert.equal((await engine.calls(root, 'incoming')).data.length, 1);
  let configuration = 'a'; engine.configuration = () => configuration;
  const before = engine.revision(); configuration = 'b'; assert.notEqual(engine.revision(), before);
});

test('project configuration identity changes on compile flags and language associations', () => {
  const env = fakeVscode();
  const { WorkspaceFileCatalog } = loadWithVscode(require.resolve('../src/infrastructure/workspace-file-catalog'), env.api);
  const catalog = new WorkspaceFileCatalog();
  try {
    const before = catalog.configurationKey();
    env.events.change.fire(env.api.Uri.file('/project/compile_commands.json'));
    const after = catalog.configurationKey(); assert.notEqual(after, before);
    env.settings.set('files.associations', { '*.h': 'c' }); assert.notEqual(catalog.configurationKey(), after);
  } finally { catalog.dispose(); }
});

test('semantic definition queries do not relabel this extension native local results as semantic', async t => {
  const env = fakeVscode(); let provider, localQueries = 0;
  env.api.languages.registerDefinitionProvider = (selector, value) => { provider = value; return { dispose() {} }; };
  const cache = new Map(), load = file => loadWithVscode(require.resolve(file), env.api, cache);
  const { LocalIndex } = load('../src/local-index'), { LanguageAdapter } = load('../src/language');
  const index = new LocalIndex(env.context, { contains: () => true }); t.after(() => index.dispose());
  const document = env.document('main.c'), point = new env.api.Position(0, 4);
  index.definitions = async () => { localQueries++; return [{ uri: document.uri, range: new env.api.Range(0, 0, 0, 4) }]; };
  load('../src/definition-provider').registerLocalDefinitions(index);
  env.commands.set('vscode.executeDefinitionProvider', async () => provider.provideDefinition(document, point, { isCancellationRequested: false }));
  const adapter = new LanguageAdapter(index); t.after(() => adapter.dispose());
  const result = await adapter.definitions(document.uri, point);
  assert.equal(result[0].provider, 'local'); assert.equal(localQueries, 1);
  assert.equal(index.semanticQueries.size, 0);
  assert.equal((await provider.provideDefinition(document, point, { isCancellationRequested: false })).length, 1);
});

test('preview retains validated function heads if a fresh symbol provider stalls', async t => {
  const env = fakeVscode(), document = env.document('reader.cpp', 'int leaf(void) { return 1; }');
  const cache = new Map(), load = name => loadWithVscode(require.resolve(name), env.api, cache);
  const { LanguageAdapter } = load('../src/language'), { ContextView } = load('../src/context');
  env.commands.set('vscode.executeDocumentSymbolProvider', async () => [{ name: 'leaf', kind: 11,
    range: new env.api.Range(0, 0, 0, 27), selectionRange: new env.api.Range(0, 4, 0, 8) }]);
  const language = new LanguageAdapter(), preview = new ContextView(language, async () => {});
  t.after(() => { preview.dispose(); language.dispose(); });
  await language.symbols(document.uri);
  env.commands.set('vscode.executeDocumentSymbolProvider', () => new Promise(() => {}));
  await preview.show({ uri: document.uri, range: new env.api.Range(0, 4, 0, 8) });
  assert.equal(preview.state.lines[0].tokens.filter(token => token.strong).map(token => token.text).join('').trim(), 'int leaf');
  document.version++; assert.deepEqual(language.cachedSymbols(document), []);
});

test('a delayed file event retries unchanged-source queries once without adopting the old reply', async t => {
  const env = fakeVscode(), document = env.document('reader.cpp'); env.api.workspace.textDocuments = [document];
  const cache = new Map(), load = name => loadWithVscode(require.resolve(name), env.api, cache);
  const catalog = new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
  const language = new (load('../src/language').LanguageAdapter)(undefined, catalog);
  t.after(() => { language.dispose(); catalog.dispose(); });
  let finish, calls = 0;
  env.commands.set('vscode.executeDefinitionProvider', async () => {
    if (++calls === 1) return new Promise(resolve => { finish = resolve; });
    return [{ uri: document.uri, range: new env.api.Range(1, 0, 1, 3) }];
  });
  const pending = language.definitions(document.uri, new env.api.Position(0, 0)); await tick();
  env.events.change.fire(env.api.Uri.file('/project/.vscode/settings.json'));
  assert.equal(language.queries.snapshot().cancelled, 0, 'theme/settings disk writes must not cancel code queries');
  env.events.change.fire(document.uri);
  assert.equal((await pending)[0].range.start.line, 1); assert.equal(calls, 2);
  finish([{ uri: document.uri, range: new env.api.Range(0, 0, 0, 3) }]); await tick();
  assert.equal(language.queryInfo('definitions', document.uri).status, 'ready');
  env.commands.set('vscode.executeDefinitionProvider', () => new Promise(resolve => { finish = resolve; }));
  const changed = language.definitions(document.uri, new env.api.Position(0, 1)), rejected = assert.rejects(changed, error => error.code === 'cancelled');
  await tick(); document.version++;
  env.events.document.fire({ document, contentChanges: [{}] }); await rejected; finish([]);
});
