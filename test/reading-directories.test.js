'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
function fixture(t) {
  const env = fakeVscode(), cache = new Map();
  const load = file => loadWithVscode(require.resolve(file), env.api, cache);
  const { WorkspaceFileCatalog, matchesGlob } = load('../src/infrastructure/workspace-file-catalog');
  const catalog = new WorkspaceFileCatalog(); t.after(() => catalog.dispose());
  const requests = [], documents = [];
  env.api.workspace.textDocuments = documents;
  env.api.workspace.findFiles = async (pattern, exclude, limit) => {
    requests.push({ pattern, exclude, limit });
    const root = pattern.baseUri || env.api.workspace.workspaceFolders[0].uri;
    const values = documents.map(doc => doc.uri).filter(uri => uri.path.startsWith(root.path.replace(/\/$/, '') + '/') &&
      (!exclude || !matchesGlob(uri.path.slice(root.path.length + 1), exclude)));
    return limit === undefined ? values : values.slice(0, limit);
  };
  env.api.workspace.fs.readFile = async uri => Buffer.from(documents.find(doc => doc.uri.toString() === uri.toString()).getText());
  const add = (file, text = 'int value;') => { const doc = env.document(file, text); documents.push(doc); return doc; };
  const configure = (includes, excludes = [], excludedFiles = []) => {
    env.settings.set('sourceInsightReader.searchDirectories', includes);
    env.settings.set('sourceInsightReader.excludedDirectories', excludes);
    env.settings.set('sourceInsightReader.excludedFiles', excludedFiles);
    env.events.configuration.fire({ affectsConfiguration: key => ['sourceInsightReader', 'sourceInsightReader.searchDirectories', 'sourceInsightReader.excludedDirectories', 'sourceInsightReader.excludedFiles'].includes(key) });
  };
  return { env, load, catalog, requests, documents, add, configure };
}
test('directory blocklist restricts enumeration before scan and uses boundary-safe subtree paths', async t => {
  const s = fixture(t);
  for (const file of ['libbmc/src/a.c', 'libbmc/build/skip.c', 'libbmc/build2/keep.c', 'linux/kernel/a.c', 'buildroot/huge.c']) s.add(file);
  s.configure([], ['libbmc/build', 'buildroot']);
  const files = await s.catalog.list({ limit: 10 });
  assert.deepEqual(files.map(uri => uri.path), ['/project/libbmc/src/a.c', '/project/libbmc/build2/keep.c', '/project/linux/kernel/a.c']);
  assert.deepEqual(s.requests.map(request => request.pattern.baseUri.path), ['/project']);
  assert.match(s.requests[0].exclude, /build\/\*\*/); assert.equal(s.requests[0].limit, 10);
  assert.equal(s.catalog.accepts(s.env.api.Uri.file('/project/buildroot/huge.c')), false);
  assert.equal(s.catalog.accepts(s.env.api.Uri.file('/project/libbmc-other/a.c')), true);
  assert.equal(s.catalog.projectKey(files[0]), s.catalog.projectKey(files[2]));
  const scanned = s.requests.length;
  assert.deepEqual(await s.catalog.list({ folder: { uri: s.env.api.Uri.file('/project/libbmc/build') } }), []);
  assert.equal(s.requests.length, scanned);
});
test('blocking directories alone keeps workspace coverage and invalid/outside scope never falls back to a broad scan', async t => {
  const s = fixture(t); s.add('libbmc/a.c'); s.add('linux/a.c'); s.add('buildroot/a.c');
  s.configure([], ['linux', 'buildroot']);
  const files = await s.catalog.list(); assert.deepEqual(files.map(uri => uri.path), ['/project/libbmc/a.c']);
  assert.equal(s.requests[0].pattern.baseUri.path, '/project'); assert.match(s.requests[0].exclude, /linux\/\*\*/);
  s.configure([], ['../outside']); const before = s.requests.length;
  await assert.rejects(s.catalog.list(), /不在已打开工作区/); assert.equal(s.requests.length, before);
  s.configure([], ['.']); assert.deepEqual(await s.catalog.list(), []); assert.equal(s.requests.length, before);
});
test('scope resolves absolute remote URIs and drops stale scans/events when the directory settings change', async t => {
  const s = fixture(t); s.add('libbmc/a.c'); s.add('linux/a.c');
  s.configure([], ['linux']); let finish;
  s.env.api.workspace.findFiles = () => new Promise(resolve => { finish = resolve; });
  const pending = s.catalog.list(); await new Promise(resolve => setImmediate(resolve));
  s.configure([], ['libbmc']); finish([s.env.api.Uri.file('/project/libbmc/a.c')]); assert.deepEqual(await pending, []);
  const events = []; s.catalog.onDidChange(event => events.push(event));
  s.env.events.change.fire(s.env.api.Uri.file('/project/libbmc/a.c')); assert.equal(events.length, 0);
  const root = s.env.api.Uri.parse('vscode-remote://ssh-remote+dev/home/work');
  s.env.api.workspace.workspaceFolders = [{ name: 'remote', uri: root }];
  s.configure([], ['vscode-remote://ssh-remote+dev/home/work/linux']);
  assert.equal(s.catalog.contains(s.env.api.Uri.parse('vscode-remote://ssh-remote+dev/home/work/libbmc/a.c')), true);
  assert.equal(s.catalog.contains(s.env.api.Uri.parse('vscode-remote://ssh-remote+other/home/work/libbmc/a.c')), false);
});
test('Context definitions, references and global semantic symbols are limited to the shared scope', async t => {
  const s = fixture(t); const inside = s.add('libbmc/a.c'), outside = s.add('linux/a.c'); s.configure([], ['linux']);
  const range = new s.env.api.Range(0, 0, 0, 1), at = doc => ({ uri: doc.uri, range });
  const { LanguageAdapter } = s.load('../src/language'); const language = new LanguageAdapter(undefined, s.catalog);
  s.env.commands.set('vscode.executeReferenceProvider', async () => [at(inside), at(outside)]);
  s.env.commands.set('vscode.executeDefinitionProvider', async () => [at(inside), at(outside)]);
  s.env.commands.set('vscode.executeWorkspaceSymbolProvider', async () => [inside, outside].map(doc => ({ name: 'value', location: at(doc) })));
  assert.equal((await language.references(inside.uri, range.start)).length, 1);
  assert.equal((await language.definitions(inside.uri, range.start)).length, 1);
  assert.equal((await language.workspaceSymbols('val')).length, 1);
  let queried = false; s.env.commands.set('vscode.executeReferenceProvider', async () => { queried = true; return []; });
  assert.deepEqual(await language.references(outside.uri, range.start), []); assert.equal(queried, false);
  assert.match((await language.contextDefinitions(outside.uri, range.start)).note, /屏蔽/);
});
test('semantic Relation filters both directions and never queries an excluded source', async t => {
  const s = fixture(t), inside = s.add('libbmc/a.c'), outside = s.add('linux/a.c'); s.configure([], ['linux']);
  const { LanguageServiceProvider } = s.load('../src/providers/relation-providers'); const provider = new LanguageServiceProvider(s.catalog);
  const range = new s.env.api.Range(0, 0, 0, 5);
  const raw = doc => ({ name: 'value', kind: 11, uri: doc.uri, range, selectionRange: range });
  s.env.commands.set('vscode.prepareCallHierarchy', async () => [raw(inside)]);
  s.env.commands.set('vscode.provideIncomingCalls', async () => [inside, outside].map(doc => ({ from: raw(doc), fromRanges: [range] })));
  s.env.commands.set('vscode.provideOutgoingCalls', async () => [inside, outside].map(doc => ({ to: raw(doc), fromRanges: [range] })));
  const roots = await provider.prepare({ uri: inside.uri.toString(), range });
  assert.equal((await provider.calls(roots.data[0], 'incoming')).data.length, 1);
  assert.equal((await provider.calls(roots.data[0], 'outgoing')).data.length, 1);
  assert.equal((await provider.prepare({ uri: outside.uri.toString(), range })).status, 'excluded');
});
test('text lookup searches the workspace and cannot reintroduce excluded dirty buffers', async t => {
  const s = fixture(t); s.add('libbmc/a.c', 'value'); s.add('linux/a.c', 'value');
  const hidden = s.add('linux/tools/a.c', 'value'); hidden.isDirty = true;
  s.add('buildroot/a.c', 'value'); s.configure([], ['linux/tools', 'buildroot']);
  const { TextLookup } = s.load('../src/text-lookup'), { TextSearchSession } = s.load('../src/features/search-sessions');
  const model = new TextLookup(s.catalog, async () => []), session = new TextSearchSession(model, s.catalog, async () => {}, async () => {});
  t.after(() => { session.dispose(); model.dispose(); });
  await session.launch('value', s.documents[0].uri);
  assert.equal(model.folder.all, true); assert.deepEqual(model.rows.map(row => row.path), ['libbmc/a.c', 'linux/a.c']);
  const state = await session.snapshot(); assert.equal(state.folders[0].name, '整个工作区');
});
test('real C worker preserves workspace calls and rebuilds when an exact file is blocked', async t => {
  const s = fixture(t), root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-directory-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  s.env.api.workspace.workspaceFolders = [{ name: 'workspace', uri: s.env.api.Uri.file(root) }];
  const files = [ ['libbmc/a.c', 'int shared(void) { return 1; }'], ['linux/b.c', 'int run(void) { return shared(); }'], ['buildroot/c.c', 'int huge(void) { return 0; }'] ];
  for (const [name, text] of files) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text);
    s.documents.push({ uri: s.env.api.Uri.file(path.join(root, name)), isDirty: false });
  }
  s.configure([], ['buildroot']); const { LocalIndex } = s.load('../src/local-index'); const index = new LocalIndex(s.env.context, s.catalog); t.after(() => index.dispose());
  await index.ensure(); assert.equal(index.summary.files, 2);
  const roots = await index.prepare(s.documents[0].uri, { line: 0, character: 5 }, 'shared');
  assert.equal((await index.calls(roots[0], 'incoming'))[0].from.name, 'run');
  s.configure([], ['buildroot'], ['libbmc/a.c']); await index.ready; assert.equal(index.summary.files, 1);
  assert.equal(index.supports(s.documents[0].uri), false); assert.equal(index.summaryScope, s.catalog.scopeKey());
});
test('blocklist popup lists files and directories, supports restore and has no add-directory action', async t => {
  const s = fixture(t); const { manageReadingDirectories } = s.load('../src/application/reading-directories');
  s.configure([], ['linux/tools'], ['libbmc/test.c']);
  let labels;
  s.env.api.window.showQuickPick = async choices => {
    labels = choices.map(choice => choice.label);
    assert.equal(choices.some(choice => choice.action === 'add'), false);
    return choices.find(choice => choice.key === 'excludedFiles');
  };
  await manageReadingDirectories(s.catalog);
  assert.ok(labels.some(label => label.includes('linux/tools')));
  assert.ok(labels.some(label => label.includes('libbmc/test.c')));
  assert.deepEqual(s.env.settings.get('sourceInsightReader.excludedFiles'), []);
  assert.deepEqual(s.env.settings.get('sourceInsightReader.excludedDirectories'), ['linux/tools']);
});

test('Windows drive and UNC directory scope uses URI boundaries and case-insensitive matching', t => {
  const s = fixture(t);
  s.env.api.workspace.workspaceFolders = [{ name: 'work', uri: s.env.api.Uri.parse('file:///C:/Work') }];
  s.configure([], ['C:\\WORK\\libbmc\\build']);
  assert(s.catalog.contains(s.env.api.Uri.parse('file:///C:/Work/libbmc/src/a.c')));
  assert(!s.catalog.contains(s.env.api.Uri.parse('file:///c:/work/libbmc/build/a.c')));
  assert(!!s.catalog.contains(s.env.api.Uri.parse('file:///c:/work/libbmc-extra/a.c')));
  s.env.api.workspace.workspaceFolders = [{ name: 'share', uri: s.env.api.Uri.parse('file://server/share/work') }];
  s.configure([], ['\\\\server\\share\\work\\build']);
  assert(s.catalog.contains(s.env.api.Uri.parse('file://SERVER/share/work/libbmc/a.c')));
});

test('scope changes clear locked Context and old results, cancel queries and refresh symbols', async t => {
  const s = fixture(t), doc = s.add('libbmc/main.c');
  const editor = await s.env.api.window.showTextDocument(doc);
  const { ReadingController } = s.load('../src/extension'); const controller = new ReadingController(s.env.context); t.after(() => controller.dispose());
  controller.language.symbols = async () => [];
  await controller.follow.acceptEditor(editor);
  await controller.preview.show({ uri: doc.uri, range: new s.env.api.Range(0, 0, 0, 1) });
  controller.preview.toggleLock(); assert(controller.preview.current);
  const before = controller.navigation.jumpGate.version;
  s.configure([], ['libbmc']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.preview.current, undefined); assert.equal(controller.preview.history.entries.length, 0);
  assert.equal(controller.relations.source, undefined); assert.equal(controller.references.source, undefined);
  assert.equal(controller.textLookup.rows.length, 0); assert(controller.navigation.jumpGate.version > before);
});

test('changing exclusions cancels initial enumeration and replaces it with a filtered scan', async t => {
  const s = fixture(t), root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-scope-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'libbmc')); const file = path.join(root, 'libbmc/a.c'); await fs.writeFile(file, 'int narrow(void) { return 1; }');
  const uri = s.env.api.Uri.file(file);
  s.env.api.workspace.workspaceFolders = [{ name: 'workspace', uri: s.env.api.Uri.file(root) }];
  let finish, oldToken; const scannedRoots = [];
  s.env.api.workspace.findFiles = (pattern, exclude, limit, cancellation) => {
    if (!finish) return new Promise(resolve => { finish = resolve; oldToken = cancellation; });
    scannedRoots.push(pattern.baseUri.path); return Promise.resolve([uri]);
  };
  const { LocalIndex } = s.load('../src/local-index'), index = new LocalIndex(s.env.context, s.catalog); t.after(() => index.dispose());
  const actions = [], request = index.request.bind(index); index.request = (action, data) => { actions.push(action); return request(action, data); };
  const initial = index.ensure(); await new Promise(resolve => setImmediate(resolve));
  s.configure([], ['buildroot']); assert.equal(oldToken.isCancellationRequested, true); assert(actions.includes('cancelScan'));
  finish([]); await initial; await index.ready;
  assert.deepEqual(scannedRoots, [root]); assert.equal(index.summary.files, 1);
  assert.equal(index.summary.functions, 1); assert.equal(index.summaryScope, s.catalog.scopeKey());
});

test('exact file blocks are excluded before enumeration, filtered from dirty buffers and escaped literally', async t => {
  const s = fixture(t);
  s.add('src/a[1].c'); s.add('src/a1.c'); s.add('src/keep.c');
  s.configure([], [], ['src/a[1].c']);
  const files = await s.catalog.list();
  assert.deepEqual(files.map(uri => uri.path), ['/project/src/a1.c', '/project/src/keep.c']);
  assert.equal(s.catalog.contains(s.env.api.Uri.file('/project/src/a[1].c')), false);
  assert.equal(s.catalog.contains(s.env.api.Uri.file('/project/src/a[1].cpp')), true);
  // Old include-directory settings must no longer narrow the workspace.
  s.env.settings.set('sourceInsightReader.searchDirectories', ['missing']);
  assert.equal(s.catalog.contains(s.env.api.Uri.file('/project/other/keep.c')), true);
});
