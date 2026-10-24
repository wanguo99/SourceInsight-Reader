'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnchor, locateAnchor } = require('../src/domain/reading-anchor');
const { findMatches } = require('../src/domain/text-search');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { TextSearchEngine } = require('../src/infrastructure/text-search-engine');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('reading anchors relocate unique code and refuse deleted or ambiguous candidates', () => {
  const text = 'int before;\nint chosen;\nint after;', anchor = createAnchor(text, 1, 5);
  assert.equal(locateAnchor(text, anchor).status, 'exact');
  assert.deepEqual(locateAnchor('// inserted\n' + text, anchor), { status: 'relocated', line: 2, character: 5 });
  assert.equal(locateAnchor('int before;\nint after;', anchor).status, 'missing');
  assert.equal(locateAnchor('int chosen;\nint chosen;', anchor).status, 'ambiguous');
  assert.equal(locateAnchor(text + '\n' + text, anchor).status, 'ambiguous');
  assert.throws(() => createAnchor('\n', 0), /代码/);
});

test('regex and multiline search retain UTF-16 columns and CRLF end coordinates', () => {
  const text = '😀 before\r\ncall(foo,\r\n  bar);\r\ncall(baz);';
  const hits = findMatches(text, 'call\\(foo,\\s+bar\\)', { regex: true, multiline: true });
  assert.equal(hits.length, 1); assert.equal(hits[0].line, 1); assert.equal(hits[0].start, 0);
  assert.equal(hits[0].endLine, 2); assert.equal(hits[0].end, 6);
  assert.equal(findMatches(text, 'foo,\n  bar', { multiline: true }).length, 1);
  assert.equal(findMatches(text, 'foo,\n  bar').length, 0);
  assert.equal(findMatches(text, '(?=a)', { regex: true }).length, 0);
  assert.equal(findMatches('😀token', 'token')[0].start, 2);
  assert.throws(() => findMatches(text, '[', { regex: true }));
});

test('a pathological regular expression is terminated without blocking the extension host and can recover', async t => {
  const engine = new TextSearchEngine({ timeout: 300 }); t.after(() => engine.dispose());
  await assert.rejects(engine.match('a'.repeat(20000) + '!', '(a+)+$', { regex: true }, 10), /预算|超时|timeout/i);
  const hits = await engine.match('int target;', 'target', {}, 10);
  assert.equal(hits.length, 1);
});

test('local bound references separate same-name parameters, globals, fields and workspace roots', async () => {
  const parser = await createParser();
  const parse = (name, text, project = 'one') => ({ ...parseC(parser, text, 'file:///project/' + name, '/project/' + name), project });
  const a = parse('a.c', 'int value;\nint use(int value) { return value; }\nint other(void) { return value; }\nstruct S { int value; };\nint member(struct S s) { return s.value; }');
  const b = parse('b.c', 'extern int value;\nint use_b(void) { return value; }');
  const peer = parse('peer.c', 'int value;\nint use_peer(void) { return value; }', 'two');
  const index = new CIndex(); index.replace([a, b, peer]);
  const locations = [...index.referenceSites(a.uri, { line: 0, character: 5 })].filter(Boolean);
  assert.deepEqual(locations.map(value => [value.uri.split('/').pop(), value.range.start.line]), [['a.c', 0], ['a.c', 2], ['b.c', 0], ['b.c', 1]]);
  const local = [...index.referenceSites(a.uri, { line: 1, character: 12 })].filter(Boolean);
  assert.equal(local.length, 2); assert(local.every(value => value.range.start.line === 1));
  const field = [...index.referenceSites(a.uri, { line: 3, character: 15 })].filter(Boolean);
  assert.deepEqual(field.map(value => value.range.start.line), [3, 4]);
  parser.delete();
});

test('include exploration exposes direct includes and reverse dependents', async () => {
  const parser = await createParser(), index = new CIndex();
  index.replace([parseC(parser, '#include "shared.h"\nint run(void) { return 0; }', 'file:///project/main.c', '/project/main.c'),
    parseC(parser, 'int shared;', 'file:///project/shared.h', '/project/shared.h')]);
  assert.equal(index.includeRelations('file:///project/main.c')[0].uri, 'file:///project/shared.h');
  assert.equal(index.includeRelations('file:///project/shared.h', true)[0].uri, 'file:///project/main.c');
  parser.delete();
});

test('diagnostic reports exclude project paths, query text, notes and raw compilation arguments', async () => {
  const env = fakeVscode(); env.api.extensions = { getExtension: () => undefined }; env.api.env = { language: 'en', remoteName: undefined };
  env.api.workspace.fs.stat = async () => { throw new Error('missing'); };
  const { ReaderTools } = loadWithVscode('../src/features/reader-tools', env.api);
  const app = { context: env.context, language: { mode: () => 'auto', queryStates: new Map([['file:///private/path.c', { status: 'ready', provider: 'local', elapsedMs: 2, note: 'secret code' }]]) },
    localIndex: { enabled: () => true, phase: 'ready', pending: new Map(), revision: 1, summary: { files: 2, failures: [{ uri: 'file:///secret/a.c', message: 'private code' }] } } };
  const tools = new ReaderTools(app); let report; tools.document = async value => { report = value; };
  await tools.diagnostics(); const json = JSON.stringify(report);
  assert.doesNotMatch(json, /private|secret|\/project|file:\/\/|undefined/);
  assert.equal(report.index.failures, 1); assert.equal(report.extensions.length, 4);
});

test('preview pin and open reject edited source and full function expands beyond context margin', async () => {
  const env = fakeVscode(), text = ['int long_function(void) {', ...Array(70).fill('  int value = 1;'), '  return 1;', '}'].join('\n');
  const doc = env.document('long.c', text); doc.languageId = 'c'; let opens = 0;
  const { ContextView } = loadWithVscode('../src/context', env.api);
  const view = new ContextView({ symbols: async () => [{ name: 'long_function', kind: 11, children: [], uri: doc.uri, range: new env.api.Range(0, 0, 73, 1) }] }, async () => opens++);
  await view.show({ uri: doc.uri, range: new env.api.Range(0, 5, 0, 18) });
  await view.fullFunction(); assert.equal(view.state.lines.length, doc.lineCount);
  doc.version++; await view.handleMessage({ action: 'open' }); assert.equal(opens, 0);
  const before = env.api.window.activeTextEditor; await view.pin(); assert.equal(env.api.window.activeTextEditor, before);
  assert.match(view.state.status, /源码已修改/); view.dispose();
});

test('first install preserves keys, layout, icon theme and shared clangd by default', () => {
  const manifest = require('../package.json'), props = manifest.contributes.configuration.properties;
  for (const key of ['sourceInsightKeys', 'symbolHighlightUseF2', 'autoConfigureClangd']) assert.equal(props['sourceInsightReader.' + key].default, false);
  assert.equal(props['sourceInsightReader.layout'].default, 'preserve'); assert.equal(manifest.contributes.configurationDefaults, undefined);
});

test('English UI resources resolve manifest keys and leave source/symbol data unchanged', () => {
  const fs = require('node:fs'), manifest = JSON.stringify(require('../package.json'));
  const en = require('../package.nls.json'), zh = require('../package.nls.zh-cn.json');
  for (const key of manifest.matchAll(/%([^%]+)%/g)) { assert.equal(typeof en[key[1]], 'string', key[1]); assert.equal(typeof zh[key[1]], 'string', key[1]); }
  assert.doesNotMatch(JSON.stringify(en), /[\u4e00-\u9fff]/);
  const env = fakeVscode(); env.api.env = { language: 'en' };
  const { t, markup } = loadWithVscode('../src/i18n', env.api);
  assert.equal(t('工程文件'), 'Project Files'); assert.equal(t('user_symbol'), 'user_symbol');
  assert.equal(markup('<button title="刷新">刷新</button>'), '<button title="Refresh">Refresh</button>');
  assert(fs.existsSync('media/messages.en.json'));
});

test('bookmark notes and saved searches survive recreation and honor current scope', async () => {
  const env = fakeVscode(), values = new Map(), doc = env.document('book.c', 'int first;\nint saved;');
  env.context.workspaceState = { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, value) };
  env.api.window.showInputBox = async () => 'Review this value';
  const source = { uri: doc.uri, range: new env.api.Range(1, 4, 1, 4), name: 'saved' };
  let allowed = true, opened;
  const root = { uri: env.api.Uri.file('/project'), name: 'project' };
  const app = { context: env.context, catalog: { document: () => doc, accepts: () => allowed }, navigation: { source: () => source, openTarget: async value => { opened = value; } },
    textLookup: { query: 'saved', folder: root, options: { regex: true, multiline: false }, search: async (query, folder, options) => { assert.equal(query, 'saved'); assert.equal(options.regex, true); } },
    textSession: { roots: () => [root] }, searchResultsView: { show: () => {} } };
  const { ReaderTools } = loadWithVscode('../src/features/reader-tools', env.api);
  await new ReaderTools(app).addBookmark(); await new ReaderTools(app).savedSearch(true);
  env.api.window.showQuickPick = async choices => choices[0];
  const tools = new ReaderTools(app); await tools.bookmarks(); assert.equal(opened.range.start.line, 1);
  assert.equal(values.get('reader.bookmarks')[0].note, 'Review this value');
  await tools.savedSearch();
  allowed = false; await assert.rejects(tools.resolve(values.get('reader.bookmarks')[0]), /屏蔽/);
});

test('semantic empty references stay authoritative while unavailable providers fall back to bound local references', async t => {
  const env = fakeVscode(), doc = env.document('fallback.c', 'int value;'); let localCalls = 0;
  const local = { enabled: () => true, supports: () => true, references: async () => { localCalls++; return { locations: [{ uri: doc.uri.toString(), range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } }] }; } };
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const language = new LanguageAdapter(local); t.after(() => language.dispose());
  env.commands.set('vscode.executeReferenceProvider', () => []);
  env.commands.set('vscode.executeDefinitionProvider', () => [{ uri: doc.uri, range: new env.api.Range(0, 4, 0, 9) }]);
  assert.equal((await language.references(doc.uri, new env.api.Position(0, 5))).length, 0); assert.equal(localCalls, 0);
  env.commands.set('vscode.executeReferenceProvider', () => undefined);
  assert.equal((await language.references(doc.uri, new env.api.Position(0, 5))).length, 1);
  assert.equal(language.queryInfo('references', doc.uri).provider, 'local');
});

test('reading data cleanup requires a category and confirmation and keeps unrelated records', async () => {
  const env = fakeVscode(), values = new Map([['reader.bookmarks', [{ note: 'private note' }]], ['reader.tasks', [{ name: 'task' }]], ['reader.searchHistory', [{ query: 'private query' }]]]);
  env.context.workspaceState = { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, value) };
  let confirmed = false, changes = 0;
  env.api.window.showQuickPick = async choices => [choices[0], choices[3]];
  env.api.window.showWarningMessage = async () => confirmed ? '删除' : undefined;
  const app = { context: env.context, textLookup: { history: ['old'], changed: () => changes++ } };
  const { ReaderTools } = loadWithVscode('../src/features/reader-tools', env.api), tools = new ReaderTools(app);
  await tools.clearData(); assert.equal(values.get('reader.bookmarks').length, 1); assert.equal(changes, 0);
  confirmed = true; await tools.clearData();
  assert.deepEqual(values.get('reader.bookmarks'), []); assert.deepEqual(values.get('reader.searchHistory'), []);
  assert.equal(values.get('reader.tasks').length, 1); assert.deepEqual(app.textLookup.history, []); assert.equal(changes, 1);
});

test('window configuration reads avoid resource overrides while resource language settings retain their URI', () => {
  const env = fakeVscode(), original = env.api.workspace.getConfiguration, reads = [];
  env.api.workspace.getConfiguration = (section, scope) => {
    reads.push({ section, scope });
    if (['sourceInsightReader', 'clangd'].includes(section)) assert.equal(scope, undefined, section);
    return original(section);
  };
  const { WorkspaceFileCatalog } = loadWithVscode('../src/infrastructure/workspace-file-catalog', env.api);
  const catalog = new WorkspaceFileCatalog(), uri = env.api.Uri.file('/project/api.h');
  const { LocalIndex } = loadWithVscode('../src/local-index', env.api), index = new LocalIndex(env.context, catalog);
  catalog.configurationKey(uri); assert(index.supportsHeader(uri));
  assert(reads.some(read => read.section === 'files' && read.scope === undefined));
  index.dispose(); catalog.dispose();
});
