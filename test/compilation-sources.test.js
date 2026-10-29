'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { compilationSources, words } = require('../src/infrastructure/compilation-sources');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-compilation-C++ 中文-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function write(name, text) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file; }
  return { root, write };
}

test('compile database discovers only its translation units and reachable project headers, including forced includes', async t => {
  const f = await fixture(t);
  await f.write('source/main.c', '#include "local.h"\n#include <common.h>\n#include <missing-sdk.h>\nint run(void) { return VALUE; }');
  await f.write('source/local.h', '#include <nested.h>');
  await f.write('include/common.h', '#define VALUE 1'); await f.write('include/nested.h', '#include "common.h"');
  await f.write('include/forced.h', '#define FORCED 1'); await f.write('unused/other.c', 'int never_indexed;');
  const database = await f.write('build/compile_commands.json', JSON.stringify([
    { directory: '..', file: 'source/main.c', arguments: ['cc', '-I', 'include', '-include', 'forced.h', '-c', 'source/main.c'] },
    { directory: '..', file: 'source/main.c', command: 'cc -I"include" -include forced.h -c source/main.c' }
  ]));
  const result = await compilationSources(database, [f.root]);
  assert.equal(result.sources, 2); assert.equal(result.files.length, 5);
  assert(result.files.includes(pathToFileURL(path.join(f.root, 'include/forced.h')).toString()));
  assert(!result.files.some(file => file.includes('unused'))); assert(result.missing.includes('missing-sdk.h'));
});

test('compile database never borrows another workspace SDK or follows symlinks outside its project', async t => {
  const f = await fixture(t), a = path.join(f.root, 'a'), b = path.join(f.root, 'b');
  await f.write('a/main.c', '#include <foreign.h>\n#include "link/foreign.h"'); await f.write('b/foreign.h', '#define FOREIGN 1');
  await fs.symlink(b, path.join(a, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const db = await f.write('a/compile_commands.json', JSON.stringify([{ directory: a, file: 'main.c', arguments: ['cc', '-I', b, 'main.c'] }]));
  const result = await compilationSources(db, [a, b]);
  assert.deepEqual(result.files, [pathToFileURL(path.join(a, 'main.c')).toString()]);
});

test('invalid compilation databases never fall back to scanning the full workspace', async t => {
  const f = await fixture(t); await f.write('main.c', 'int x;');
  const db = await f.write('compile_commands.json', '{}');
  await assert.rejects(compilationSources(db, [f.root]), /JSON 数组/);
  await fs.writeFile(db, JSON.stringify([{ directory: '/not-this-project', file: 'main.c', command: 'cc main.c' }]));
  await assert.rejects(compilationSources(db, [f.root]), /没有可索引/);
  assert.deepEqual(words('cc -I"a b" -DNAME=\'a b\' source.c'), ['cc', '-Ia b', '-DNAME=a b', 'source.c']);
  assert.throws(() => words('cc "unfinished'), /未闭合/);
});

test('manual mode blocks all automatic worker startup until the explicit start action', async t => {
  const f = await fixture(t), file = await f.write('main.c', 'int ready(void) { return 1; }');
  const env = fakeVscode(), cache = new Map(), load = name => loadWithVscode(require.resolve(name), env.api, cache);
  env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file(f.root), name: 'root' }];
  env.api.workspace.findFiles = async () => [env.api.Uri.file(file)];
  const catalog = new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
  const index = new (load('../src/local-index').LocalIndex)(env.context, catalog, () => {}, { manualStart: true });
  t.after(() => { index.dispose(); catalog.dispose(); });
  assert.equal(await index.ensure(), false); await index.refresh();
  assert.equal(index.worker, undefined); assert.match(index.getStatus().message, /开始索引/);
  assert.equal(index.getStatus().hasIndex, false);
  await index.startSession(); assert.equal(index.summary.files, 1);
  env.events.configuration.fire({ affectsConfiguration: key => key === 'sourceInsightReader.projectSources' });
  assert.equal(index.enabled(), false); assert.equal(await index.ensure(), false);
  assert.equal(index.worker, undefined);
});

test('real compilation worker supplies a bounded catalog and its scope persists only after explicit preparation', async t => {
  const f = await fixture(t); await f.write('main.c', 'int compiled(void) { return 0; }');
  const db = await f.write('compile_commands.json', JSON.stringify([{ directory: f.root, file: 'main.c', arguments: ['cc', 'main.c'] }]));
  const env = fakeVscode(), cache = new Map(); env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file(f.root), name: 'root' }];
  env.settings.set('sourceInsightReader.projectSources', { mode: 'compilation', directories: [], files: [], compilationDatabase: pathToFileURL(db).toString().replace(/\+/g, '%2B') });
  const { WorkspaceFileCatalog } = loadWithVscode(require.resolve('../src/infrastructure/workspace-file-catalog'), env.api, cache);
  const catalog = new WorkspaceFileCatalog(); t.after(() => catalog.dispose());
  assert.deepEqual(await catalog.list(), []);
  await catalog.prepareIndex();
  assert.equal(catalog.scope.snapshot().includedFiles.length, 1);
  assert.equal(catalog.contains(env.api.Uri.file(path.join(f.root, 'main.c'))), true);
  assert.equal(catalog.contains(env.api.Uri.file(path.join(f.root, 'other.c'))), false);
  const selection = catalog.scope.selection();
  env.settings.set('sourceInsightReader.projectSources', { ...selection, pathMappings: [{ from: path.join(f.root, 'unused-build'), to: f.root }] });
  assert.equal(catalog.scope.snapshot().includedFiles.length, 0);
  await catalog.prepareIndex();
  assert.equal(catalog.scope.snapshot().includedFiles.length, 1, 'Same file list with a new mapping must replace the temporarily empty scope');
});

test('Buildroot mappings read current source and remap include and forced include paths', async t => {
  const f = await fixture(t), source = path.join(f.root, 'source'), build = path.join(f.root, 'build');
  await f.write('source/main.c', '#include <api.h>\n#include "new.h"');
  await f.write('source/new.h', '#define NEW 1'); await f.write('source/include/api.h', '#define API 1');
  await f.write('source/include/forced.h', '#define FORCED 1');
  await f.write('build/main.c', 'stale build copy');
  const db = await f.write('build/compile_commands.json', JSON.stringify([
    { directory: build, file: 'main.c', arguments: ['cc', '-I', path.join(build, 'include'), '-include', path.join(build, 'include/forced.h')] },
    { directory: build, file: 'generated.c', arguments: ['cc'] }
  ]));
  const result = await compilationSources(db, [source], () => {}, [{ from: build, to: source }]);
  assert.equal(result.mappedSources, 1); assert.equal(result.missingSources, 1);
  assert.equal(result.files.length, 4); assert(result.files.every(file => file.startsWith(pathToFileURL(source).toString() + '/')));
  assert(result.files.some(file => file.endsWith('/new.h')));
});

test('make O= database resolves relative original source before applying output mapping', async t => {
  const f = await fixture(t), source = path.join(f.root, 'source'), build = path.join(f.root, 'output');
  await f.write('source/drivers/main.c', '#include <api.h>\n#include <generated/autoconf.h>');
  await f.write('source/include/api.h', '#define API 1');
  await f.write('output/include/generated/autoconf.h', '#define CONFIG_TEST 1');
  const db = await f.write('output/compile_commands.json', JSON.stringify([
    { directory: build, file: '../source/drivers/main.c', arguments: ['cc', '-I../source/include', '-Iinclude'] }
  ]));
  for (const mappings of [[], [{ from: build, to: source }]]) {
    const result = await compilationSources(db, [source], () => {}, mappings);
    assert.equal(result.sources, 1); assert.equal(result.files.length, 2);
    assert(result.missing.includes('generated/autoconf.h'));
  }
});

test('mapping rejects foreign targets, conflicting roots and symlink escapes', async t => {
  const f = await fixture(t), source = path.join(f.root, 'source'), build = path.join(f.root, 'build'), other = path.join(f.root, 'other');
  await f.write('source/main.c', 'int x;'); await f.write('other/main.c', 'int y;');
  const db = await f.write('build/compile_commands.json', JSON.stringify([{ directory: build, file: 'main.c', arguments: ['cc'] }]));
  await assert.rejects(compilationSources(db, [source], () => {}, [{ from: build, to: other }]), /工作区/);
  await assert.rejects(compilationSources(db, [source], () => {}, [{ from: build, to: source }, { from: build, to: source + '/sub' }]), /多个源码/);
  await fs.symlink(other, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(compilationSources(db, [source], () => {}, [{ from: build, to: path.join(source, 'link') }]), /符号链接/);
});

test('validated compilation manifests enumerate thousands of files without repeated remote stat or whole-tree scans', async t => {
  const env = fakeVscode(), cache = new Map();
  const root = env.api.Uri.file('/tmp/build/linux-custom');
  env.api.workspace.workspaceFolders = [{ uri: root, name: 'kernel' }];
  const selection = { mode: 'compilation', directories: [], files: [], compilationDatabase: env.api.Uri.joinPath(root, 'compile_commands.json').toString() };
  env.settings.set('sourceInsightReader.projectSources', selection);
  const load = name => loadWithVscode(require.resolve(name), env.api, cache);
  const catalog = new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
  const index = new (load('../src/local-index').LocalIndex)(env.context, catalog);
  t.after(() => { index.dispose(); catalog.dispose(); });
  catalog.scope.compilation = { database: selection.compilationDatabase, selectionKey: JSON.stringify(selection), fingerprint: 'large-manifest',
    files: Array.from({ length: 6000 }, (_, i) => env.api.Uri.joinPath(root, 'kernel', `source-${i}.c`).toString()) };
  env.api.workspace.fs.stat = async () => assert.fail('Compilation Worker already validated the files');
  env.api.workspace.findFiles = async () => assert.fail('Must not enumerate the entire build tree');
  const files = await catalog.list({ pattern: '**/*.c' });
  assert.equal(files.length, 6000);
  assert(index.supports(files[0]), 'Parent directory named build must not exclude the workspace');
  assert.equal(index.isExcluded(env.api.Uri.joinPath(root, 'build', 'generated.c'), '**/build/**'), true);
  assert.equal((await catalog.list({ pattern: '**/*.c', limit: 3 })).length, 3);
  const cancellation = { isCancellationRequested: false };
  setImmediate(() => { cancellation.isCancellationRequested = true; });
  assert.deepEqual(await catalog.list({ pattern: '**/*.c', cancellation }), []);
  env.settings.set('sourceInsightReader.projectSources', { ...selection, pathMappings: [{ from: '/tmp/copy', to: root.fsPath }] });
  assert.deepEqual(await catalog.list(), [], 'Changed mappings must invalidate the old compiled scope until explicit preparation');
});


test('Context index commands reuse saved scopes and reread compilation files without opening configuration', async t => {
  const f = await fixture(t);
  const main = await f.write('main.c', 'int original(void) { return 1; }');
  const added = await f.write('added.c', 'int added(void) { return 2; }');
  const database = await f.write('compile_commands.json', JSON.stringify([{ directory: f.root, file: 'main.c', arguments: ['cc', 'main.c'] }]));
  for (const mode of ['selected', 'workspace', 'compilation']) {
    const env = fakeVscode(), cache = new Map(), handlers = new Map();
    env.api.workspace.workspaceFolders = [{ uri: env.api.Uri.file(f.root), name: 'root' }];
    env.api.workspace.findFiles = async () => [env.api.Uri.file(main), env.api.Uri.file(added)];
    env.api.workspace.fs.stat = async uri => ({ type: (await fs.stat(uri.fsPath)).isDirectory() ? 2 : 1 });
    const selection = { mode, directories: [], files: mode === 'selected' ? ['main.c'] : [],
      ...(mode === 'compilation' ? { compilationDatabase: pathToFileURL(database).toString() } : {}) };
    env.settings.set('sourceInsightReader.projectSources', selection);
    const saved = JSON.stringify(selection);
    const load = name => loadWithVscode(require.resolve(name), env.api, cache);
    const catalog = new (load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
    const index = new (load('../src/local-index').LocalIndex)(env.context, catalog, () => {}, { manualStart: true });
    try {
      const app = { commands: { add: (name, action) => handlers.set(name, action) }, preview: {}, localIndex: index,
        projectSources: { show: () => assert.fail('Index commands must not open the configuration panel') } };
      load('../src/application/commands').registerCommands(app);
      assert.equal(index.worker, undefined);
      await handlers.get('startIndex')();
      assert.equal(index.summary.files, mode === 'workspace' ? 2 : 1);
      if (mode === 'compilation') {
        await fs.writeFile(database, JSON.stringify(['main.c', 'added.c'].map(file => ({ directory: f.root, file, arguments: ['cc', file] }))));
      }
      await handlers.get('rebuildIndex')();
      assert.equal(index.summary.files, mode === 'selected' ? 1 : 2);
      assert.equal(JSON.stringify(env.settings.get('sourceInsightReader.projectSources')), saved);
    } finally { index.dispose(); catalog.dispose(); }
  }
});

test('index command ignores duplicate starts while busy and allows a retry after failure', async () => {
  const env = fakeVscode(), handlers = new Map(); let busy = false, calls = 0, fail = true;
  const app = { commands: { add: (name, action) => handlers.set(name, action) }, preview: {},
    localIndex: { getStatus: () => ({ busy }), startSession: async () => { calls++; if (fail) { fail = false; throw new Error('invalid compilation database'); } } },
    projectSources: { show: () => assert.fail('Indexing must not open configuration') } };
  loadWithVscode('../src/application/commands', env.api).registerCommands(app);
  busy = true; await handlers.get('startIndex')(); await handlers.get('rebuildIndex')();
  assert.equal(calls, 0);
  busy = false;
  await assert.rejects(handlers.get('rebuildIndex')(), /invalid compilation database/);
  await handlers.get('rebuildIndex')();
  assert.equal(calls, 2);
});


test('dependency discovery honors BOMs and per-root encodings and fails explicitly on invalid source', async t => {
  const f = await fixture(t);
  const main = await f.write('main.c', '');
  const header = await f.write('ops.h', '#define VALUE 1');
  const db = await f.write('compile_commands.json', JSON.stringify([{directory:f.root,file:'main.c',arguments:['cc','main.c']}]));
  const text = '#include "ops.h"\nint run(void) { return VALUE; }\n';
  for (const bom of [true, false]) {
    await fs.writeFile(main, Buffer.concat([bom ? Buffer.from([255,254]) : Buffer.alloc(0), Buffer.from(text,'utf16le')]));
    const settings = bom ? {} : {encodings:[{root:f.root,encoding:'utf16le'}]};
    if (!bom) await fs.writeFile(header, Buffer.from('#define VALUE 1','utf16le'));
    const result = await compilationSources(db,[f.root],()=>{},[],settings);
    assert(result.files.includes(pathToFileURL(header).toString())); assert.deepEqual(result.missing,[]);
  }
  await fs.writeFile(main,Buffer.from([0xff,0x20,0x61]));
  await assert.rejects(compilationSources(db,[f.root]),/头文件依赖发现无法读取.*main.c/);
});

test('real compilation worker uses configured encoding for discovered headers', async t => {
  const f = await fixture(t);
  await fs.writeFile(await f.write('main.c',''), Buffer.from('#include "ops.h"\nint run(void) { return VALUE; }','utf16le'));
  await fs.writeFile(await f.write('ops.h',''),Buffer.from('#define VALUE 1','utf16le'));
  const db = await f.write('compile_commands.json',JSON.stringify([{directory:f.root,file:'main.c',arguments:['cc','main.c']}]));
  const env = fakeVscode(), cache = new Map(); env.api.workspace.workspaceFolders=[{uri:env.api.Uri.file(f.root),name:'root'}];
  env.settings.set('files.encoding','utf16le');
  env.settings.set('sourceInsightReader.projectSources',{mode:'compilation',directories:[],files:[],compilationDatabase:pathToFileURL(db).toString()});
  const {WorkspaceFileCatalog} = loadWithVscode(require.resolve('../src/infrastructure/workspace-file-catalog'),env.api,cache);
  const catalog = new WorkspaceFileCatalog(); t.after(()=>catalog.dispose());
  const result = await catalog.prepareIndex();
  assert.equal(result.files.length,2); assert(result.files.some(file=>file.endsWith('/ops.h')));
});


test('legacy encoded include names resolve the physical Unicode header path', async t => {
  const f = await fixture(t);
  await fs.writeFile(await f.write('main.c',''),Buffer.concat([Buffer.from('#include "'),Buffer.from([0xb2,0xe2,0xca,0xd4]),Buffer.from('.h"\nint run(void) { return VALUE; }')]));
  const header = await f.write('测试.h','#define VALUE 1');
  const db = await f.write('compile_commands.json',JSON.stringify([{directory:f.root,file:'main.c',arguments:['cc','main.c']}]));
  const result = await compilationSources(db,[f.root],()=>{},[],{encodings:[{root:f.root,encoding:'gbk'}]});
  assert(result.files.includes(pathToFileURL(header).toString())); assert.deepEqual(result.missing,[]);
});
