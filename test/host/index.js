'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ContextView } = require('../../src/context');
const { SymbolTree, ReferencesTree } = require('../../src/trees');
const { locationKey } = require('../../src/core');
const { captureUi } = require('./capture');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(action, predicate, description, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let result;
  while (Date.now() < deadline) {
    result = await action();
    if (predicate(result)) return result;
    await sleep(250);
  }
  throw new Error(`Timed out: ${description}; last result: ${JSON.stringify(result)}`);
}
function at(document, text, offset = 0) {
  const index = document.getText().indexOf(text);
  assert.notEqual(index, -1, `Missing fixture text: ${text}`);
  const position = document.positionAt(index + offset);
  return { uri: document.uri, range: new vscode.Range(position, position), name: text };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function run() {
  const results = [];
  let completed = false;
  async function check(name, action, skip) {
    if (skip) { results.push({ name, skipped: skip }); console.log(`SKIP ${name}: ${skip}`); return; }
    const start = Date.now();
    try { await action(); }
    catch (error) { results.push({ name, passed: false, error: String(error) }); throw error; }
    results.push({ name, passed: true, durationMs: Date.now() - start });
    console.log(`PASS ${name}`);
  }
  const extension = vscode.extensions.getExtension('wanguo.wanguo-sourceinsight-reader');
  assert.ok(extension, 'Extension was discovered');
  const controller = await extension.activate();
  const config = vscode.workspace.getConfiguration('sourceInsightReader');
  const oldAutoPreview = config.inspect('autoPreview')?.workspaceValue;
  const oldAutoRelation = config.inspect('autoRelation')?.workspaceValue;
  await config.update('autoPreview', false, vscode.ConfigurationTarget.Workspace);
  await config.update('autoRelation', false, vscode.ConfigurationTarget.Workspace);
  try {
    await check('local Context resolves enums with real VS Code positions across the Worker boundary', async () => {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'local-index.c');
      fs.writeFileSync(uri.fsPath, 'enum Backoff { BMC_BACKOFF_UNSUPPORTED = 4 };\n' +
        'int leaf(void) { return 0; }\nint caller(void) { return BMC_BACKOFF_UNSUPPORTED + leaf(); }\n' +
        'struct Sensor { int value; };\nstruct Sensor *read_sensor(struct Sensor *sensor) { return sensor; }\n' +
        'struct Result { struct Sensor *samples; };\nvoid consume(struct Result *result) { result->samples; }\n');
      const document = await vscode.workspace.openTextDocument(uri);
      await controller.localIndex.refresh(true);
      const previousWorker = controller.localIndex.worker, previousCount = controller.localIndex.summary.files;
      await controller.localIndex.request('flush'); await controller.localIndex.refresh(true);
      assert.notEqual(controller.localIndex.worker, previousWorker);
      assert.equal(previousWorker.threadId, -1);
      assert.equal(controller.localIndex.summary.files, previousCount);
      const position = new vscode.Position(2, document.lineAt(2).text.indexOf('BMC_BACKOFF_UNSUPPORTED'));
      const definitions = await controller.localIndex.definitions(uri, position);
      assert.equal(definitions.length, 1);
      assert.equal(definitions[0].range.start.line, 0);
      await controller.preview.definition({ uri, range: new vscode.Range(position, position) });
      assert.equal(controller.preview.current.uri.toString(), uri.toString());
      assert.equal(controller.preview.current.range.start.line, 0);
      const call = new vscode.Position(2, document.lineAt(2).text.indexOf('leaf'));
      assert.equal((await controller.localIndex.prepare(uri, call))[0].name, 'leaf');
      for (const character of [document.lineAt(4).text.indexOf('Sensor'), document.lineAt(4).text.lastIndexOf('Sensor')]) {
        await controller.preview.show({ uri, range: new vscode.Range(4, 0, 4, 0) });
        await controller.preview.handleMessage({ action: 'navigate', snapshot: controller.preview.snapshot, line: 4, character });
        assert.equal(controller.preview.current.range.start.line, 3);
        assert.equal(controller.preview.current.range.start.character, 7);
      }
      await controller.preview.show({ uri, range: new vscode.Range(6, 0, 6, 0) });
      await controller.preview.handleMessage({ action: 'navigate', snapshot: controller.preview.snapshot, line: 6,
        character: document.lineAt(6).text.indexOf('samples') });
      assert.equal(controller.preview.current.range.start.line, 5, 'field click stays on its declaration');
      await controller.preview.handleMessage({ action: 'navigate', snapshot: controller.preview.snapshot, line: 5,
        character: document.lineAt(5).text.indexOf('Sensor') });
      assert.equal(controller.preview.current.range.start.line, 3, 'type name click enters the field type');
      await controller.preview.show({ uri, range: new vscode.Range(6, 0, 6, 0) });
      await controller.preview.handleMessage({ action: 'navigate', snapshot: controller.preview.snapshot, line: 6,
        character: document.lineAt(6).text.lastIndexOf('result') });
      assert.equal(controller.preview.current.range.start.line, 6, 'variable click stays on its declaration');
      assert.equal(controller.preview.current.range.start.character, document.lineAt(6).text.indexOf('result'));
    });
    await check('index recovery: C-compatible headers, GNU attributes, comment encoding and issue locations', async () => {
      const folder = vscode.workspace.workspaceFolders[0].uri;
      const shared = vscode.Uri.joinPath(folder, 'recovery-shared.h'), client = vscode.Uri.joinPath(folder, 'recovery-client.c');
      const encoded = vscode.Uri.joinPath(folder, 'recovery-encoding.c'), malformed = vscode.Uri.joinPath(folder, 'recovery-malformed.c');
      fs.writeFileSync(shared.fsPath, '#ifdef __cplusplus\n#define _Atomic(X) std::atomic<X>\n#endif\nstruct SharedRecovery { int value; };\n');
      fs.writeFileSync(client.fsPath, '#include "recovery-shared.h"\nint recovered(struct SharedRecovery *r) { int data[2] __attribute__((aligned(32))) = {0}; return r->value + data[0]; }\n');
      fs.writeFileSync(encoded.fsPath, Buffer.concat([Buffer.from('/* note '), Buffer.from([0x92]), Buffer.from(' */\nint decoded(void) { return 1; }\n')]));
      fs.writeFileSync(malformed.fsPath, 'int incomplete( {\n');
      const doc = await vscode.workspace.openTextDocument(client);
      await controller.localIndex.refresh(true);
      assert((await controller.localIndex.symbols(shared)).some(value => value.name === 'SharedRecovery'));
      const position = new vscode.Position(1, doc.lineAt(1).text.indexOf('value'));
      const definitions = await controller.localIndex.definitions(client, position);
      assert.equal(definitions.length, 1); assert.equal(definitions[0].uri.toString(), shared.toString());
      assert((await controller.localIndex.symbols(encoded)).some(value => value.name === 'decoded'));
      const issues = await controller.localIndex.issues();
      assert(issues.some(issue => issue.uri === encoded.toString() && issue.kind === 'warning'));
      assert(issues.some(issue => issue.uri === malformed.toString() && issue.kind === 'parseRecovery' && issue.range));
    });
    await check('release indexing: recovered macros, native header links, cast fields and missing SDK explanations', async () => {
      const folder = vscode.workspace.workspaceFolders[0].uri, header = vscode.Uri.joinPath(folder, 'release-macros.h'), source = vscode.Uri.joinPath(folder, 'release-macros.c');
      const loop = vscode.Uri.joinPath(folder, 'release-loop.c');
      fs.writeFileSync(header.fsPath, '#define BASE 14\n#define ALIAS BASE\n#define COUNT(x) (x + BASE)\nstruct ReleaseRecord { int value; };\n');
      fs.writeFileSync(source.fsPath, '#include "release-macros.h"\n#include "reader_missing_sdk_header.h"\nint run_release(void *p){return ((struct ReleaseRecord*)p)->value+ALIAS;}\nint unknown_release=UNKNOWN_SDK_MACRO;\n' +
        'int split_guard(int round){\n#if HAS_COLLECTOR\n if(!round){\n#endif\n int local=1;\n#if HAS_COLLECTOR\n local++;\n }\n#else\n (void)round;\n#endif\n return round;\n}\n');
      fs.writeFileSync(loop.fsPath, 'int visit_loop(void *array){\n void *item;\n cJSON_ArrayForEach(item,array)\n { use(item); }\n return 0;\n}\n');
      const h = await vscode.workspace.openTextDocument(header), c = await vscode.workspace.openTextDocument(source);
      await controller.localIndex.refresh(true);
      assert.equal((await controller.localIndex.definitions(header, new vscode.Position(1, h.lineAt(1).text.lastIndexOf('BASE'))))[0].range.start.line, 0);
      const parameter = await controller.localIndex.definitions(header, new vscode.Position(2, h.lineAt(2).text.indexOf('x +')));
      assert.equal(parameter[0].range.start.character, h.lineAt(2).text.indexOf('x)'));
      const native = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', header, new vscode.Position(1, h.lineAt(1).text.lastIndexOf('BASE')));
      assert(native.some(value => (value.uri || value.targetUri).toString() === header.toString() && (value.range || value.targetSelectionRange).start.line === 0));
      const field = await controller.localIndex.definitions(source, new vscode.Position(2, c.lineAt(2).text.indexOf('value')));
      assert.equal(field[0].uri.toString(), header.toString()); assert.equal(field[0].range.start.line, 3);
      const explanation = await controller.localIndex.explain(source, new vscode.Position(3, c.lineAt(3).text.indexOf('UNKNOWN_SDK_MACRO')));
      assert.equal(explanation.reason, 'unresolvedInclude'); assert.match(explanation.note, /reader_missing_sdk_header.h/);
      assert((await controller.localIndex.symbols(source)).some(node => node.name === 'split_guard'));
      const issues = await controller.localIndex.issues();
      assert(!issues.some(issue => issue.uri === source.toString() && issue.kind === 'parseRecovery'));
      assert(issues.some(issue => issue.uri === loop.toString() && issue.range?.start.line === 2));
    });
    await check('installed Worker isolates projects and reuses parent/child facts with fresh bindings', async () => {
      const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'reader-host-isolation-'));
      const roots = ['app', 'sdk'].map(name => ({ uri: vscode.Uri.file(path.join(temporary, name)) }));
      for (const root of roots) fs.mkdirSync(root.uri.fsPath);
      const source = vscode.Uri.joinPath(roots[0].uri, 'nested/main.c'), header = vscode.Uri.joinPath(roots[1].uri, 'api.h');
      fs.mkdirSync(path.dirname(source.fsPath));
      fs.writeFileSync(header.fsPath, '#define SDK_LIMIT 14\nstatic inline int api(void){return 1;}');
      fs.writeFileSync(source.fsPath, '#include "api.h"\nint run(void){return SDK_LIMIT + api();}');
      const folder = uri => roots.find(root => uri.path.startsWith(root.uri.path + '/'));
      const events = new vscode.EventEmitter();
      const catalog = { list: async () => [source, header], documents: () => [], document: () => undefined, roots: () => roots,
        projectKey: uri => folder(uri)?.uri.toString(), contains: uri => Boolean(folder(uri)), accepts: uri => Boolean(folder(uri)),
        scopeKey: () => 'isolated-projects', onDidChange: events.event };
      const { LocalIndex } = require(path.join(extension.extensionPath, 'src/local-index'));
      const index = new LocalIndex({ storageUri: vscode.Uri.file(path.join(temporary, 'storage')) }, catalog);
      try {
        await index.ensure();
        assert.deepEqual(await index.definitions(source, new vscode.Position(1, 21)), []);
        const functions = await index.prepare(source, new vscode.Position(1, 5)); assert.equal(functions[0].name, 'run');
        const outgoing = await index.calls(functions[0], 'outgoing'); assert(outgoing[0].to.sourceInsightReaderLocal.unresolved);
        assert.deepEqual(await index.includeRelations(source), []);
        const explanation = await index.explain(source, new vscode.Position(1, 21)); assert.match(explanation.note, /不会使用其他工作区根/);
      } finally { await index.stopWorker(new Error('isolation test complete')); index.dispose(); events.dispose(); }
      const verifyReuse = async (root, files, expectedDefinitions) => {
        const change = new vscode.EventEmitter(), project = vscode.Uri.file(root);
        const catalog = { list: async () => files, documents: () => [], document: () => undefined, roots: () => [{ uri: project }],
          projectKey: () => project.toString(), contains: uri => files.some(file => file.toString() === uri.toString()),
          accepts: uri => files.some(file => file.toString() === uri.toString()), scopeKey: () => project.toString(), onDidChange: change.event };
        const reused = new LocalIndex({ storageUri: vscode.Uri.file(path.join(temporary, 'storage')) }, catalog);
        try {
          await reused.ensure(); assert.equal(reused.summary.inheritedFiles, files.length); assert.equal(reused.summary.parsedFiles, 0);
          assert.equal((await reused.definitions(source, new vscode.Position(1, 21))).length, expectedDefinitions);
        } finally { await reused.stopWorker(new Error('cache reuse test complete')); reused.dispose(); change.dispose(); }
      };
      await verifyReuse(temporary, [source, header], 1);
      await verifyReuse(path.dirname(source.fsPath), [source], 0);
    });
    const clangd = vscode.extensions.getExtension('llvm-vs-code-extensions.vscode-clangd');
    assert.ok(clangd, 'clangd extension must be installed');
    await clangd.activate();
    const clangdPath = vscode.workspace.getConfiguration('clangd').get('path', 'clangd');
    const version = await promisify(execFile)(clangdPath, ['--version'], { encoding: 'utf8' });
    const major = Number(/version\s+(\d+)/.exec(version.stdout)?.[1] || 0);
    if (globalThis.process.env.SOURCEINSIGHT_READER_REQUIRE_OUTGOING === '1' && major < 20) throw new Error('clangd 20+ is required for this quality gate');
    const folder = vscode.workspace.workspaceFolders[0].uri;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'reader.cpp'));
    const main = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'main.cpp'));
    const header = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'reader.h'));
    await vscode.window.showTextDocument(main);
    await vscode.window.showTextDocument(header);
    const editor = await vscode.window.showTextDocument(document);
    await controller.follow.acceptEditor(editor);
    const leaf = at(document, 'leaf(int', 1);
    const process = at(document, 'process_request(const', 1);
    const call = at(document, 'leaf(request.value)', 1);
    const recurse = at(document, 'recurse(int', 1);

    await check('clangd: current-file symbols and function list', async () => {
      await waitFor(() => controller.language.symbols(document.uri), nodes => nodes.some(node => node.name === 'leaf'), 'clangd symbols');
      await controller.symbols.load(document.uri);
      assert.ok(controller.symbols.nodes.some(node => node.name === 'process_request'));
      const tree = controller.symbols.getChildren();
      assert.ok(tree.some(node => node.name === 'leaf'));
    });

    await check('file catalog: source files discoverable and exact folder identity retained', async () => {
      const uris = await controller.catalog.list();
      assert.ok(uris.some(uri => uri.toString() === document.uri.toString()));
      assert.equal(controller.catalog.folder(document.uri).uri.toString(), folder.toString());
    });

    await check('unified index: real clangd and local outlines share durable per-folder storage', async () => {
      await controller.localIndex.ensure();
      assert.equal(controller.localIndex.summary.database.engine, 'sqlite');
      assert((await controller.localIndex.symbols(document.uri)).length, 'C++ has an offline outline');
      await waitFor(async () => {
        await controller.language.symbols(document.uri);
        const request = controller.indexStore.descriptor(document.uri, 'symbols');
        return request ? controller.indexStore.read(request) : undefined;
      }, values => values?.some(node => node.name === 'leaf'), 'persisted clangd document symbols');
      const { UnifiedIndexClient } = require(path.join(extension.extensionPath, 'src/infrastructure/unified-index-client'));
      const reopened = new UnifiedIndexClient(controller.context, controller.catalog);
      try {
        const cached = await reopened.read(reopened.descriptor(document.uri, 'symbols'));
        assert(cached.some(node => node.name === 'leaf')); assert.equal(typeof cached[0].range.start.line, 'number');
      } finally { reopened.dispose(); }
    });

    await check('theme: function return type and name are emphasized without formatting the body', async () => {
      const workbench = vscode.workspace.getConfiguration('workbench');
      const oldTheme = workbench.inspect('colorTheme')?.workspaceValue;
      try {
        await workbench.update('colorTheme', 'SourceInsight-Reader Source Insight', vscode.ConfigurationTarget.Workspace);
        await controller.symbols.load(document.uri);
        const cached = await waitFor(() => controller.functionHeadStyle.cache.get(document), value => value?.ranges.some(range =>
          range.end.line === leaf.range.start.line && range.end.character > leaf.range.start.character), 'native function-head snapshot');
        const head = cached.ranges.find(range => range.end.line === leaf.range.start.line && range.end.character > leaf.range.start.character);
        assert.ok(head, 'Native editor has a function-head decoration range');
        const text = document.getText(new vscode.Range(head.start, head.end));
        assert.match(text, /int\s+leaf$/);
        assert(!text.includes('{'));
        assert.equal(document.getText(new vscode.Range(head.name.start, head.name.end)), 'leaf');
        assert.match(document.getText(new vscode.Range(head.parameters.start, head.parameters.end)), /^\(int /);
        await controller.preview.show({ uri: document.uri, range: leaf.range });
        const state = await waitFor(async () => controller.preview.state, state =>
          state.lines.some(line => line.tokens.some(token => token.strong && token.text === 'leaf')), 'Context function emphasis');
        const line = state.lines.find(line => line.number === leaf.range.start.line + 1);
        assert.equal(line.tokens.filter(token => token.strong).map(token => token.text).join('').trim(), 'int leaf');
        assert.equal(line.tokens.filter(token => token.emphasis === 'function-name').map(token => token.text).join(''), 'leaf');
        assert.match(line.tokens.filter(token => token.emphasis === 'function-parameters').map(token => token.text).join(''), /^\(int /);
        const spans = await controller.language.semanticTokens(document.uri);
        assert(spans.length, 'The editor semantic provider supplies preview token classifications');
        const variable = spans.find(span => ['variable', 'parameter', 'property'].includes(span.type));
        assert(variable);
        const color = require('../../src/preview-colors').semanticColor(variable.type, variable.modifiers, document.languageId);
        const point = new vscode.Position(variable.line, variable.start);
        await controller.preview.show({ uri: document.uri, range: new vscode.Range(point, point) });
        await waitFor(async () => controller.preview.state, state => {
          const row = state.lines.find(row => row.number === variable.line + 1);
          if (!row) return false;
          let offset = 0;
          return row.tokens.some(token => {
            const matches = offset === variable.start && token.foreground === color;
            offset += token.text.length; return matches;
          });
        }, 'Context variable color matches the native semantic theme rule');
      } finally { await workbench.update('colorTheme', oldTheme, vscode.ConfigurationTarget.Workspace); }
    });

    await check('clangd: definition and Context preserve main reading position', async () => {
      const definitions = await controller.language.definitions(call.uri, call.range.start);
      assert.ok(definitions.length);
      assert.equal(path.basename(definitions[0].uri.fsPath), 'reader.cpp');
      const before = editor.selection;
      await controller.preview.definition(call);
      assert.ok(controller.preview.current);
      assert.equal(controller.preview.current.uri.toString(), definitions[0].uri.toString());
      assert.equal(vscode.window.activeTextEditor, editor);
      assert.equal(editor.selection, before);
      assert.ok(controller.preview.state.lines.some(line => line.text.includes('int leaf(int value)')));
    });

    await check('Context: lock blocks selection and refresh keeps pinned target', async () => {
      const original = locationKey(controller.preview.current);
      controller.preview.toggleLock();
      await controller.preview.show({ ...process, mode: '定义' });
      assert.equal(locationKey(controller.preview.current), original);
      await controller.preview.refresh();
      assert.equal(locationKey(controller.preview.current), original);
      controller.preview.toggleLock();
    });

    await check('clangd: incoming calls retain both process_request call sites', async () => {
      controller.relations.direction = 'incoming';
      await controller.relations.setRoot(leaf, { manual: true });
      assert.ok(controller.relations.root);
      const children = await waitFor(async () => (await controller.relations.load(controller.relations.root, 'incoming')).data,
        nodes => nodes.some(node => node.symbol.name.includes('process_request')), 'incoming process_request');
      const caller = children.find(node => node.symbol.name.includes('process_request'));
      assert.equal(caller.sites.length, 2);
      assert.ok(caller.sites.every(site => site.uri.toString() === document.uri.toString()));
      await controller.navigation.selectTarget({ type: 'callsite', uri: vscode.Uri.parse(caller.sites[0].uri), range: new vscode.Range(caller.sites[0].range.start.line, caller.sites[0].range.start.character, caller.sites[0].range.end.line, caller.sites[0].range.end.character) });
      assert.equal(controller.preview.current.mode, '调用现场');
      assert.equal(controller.preview.current.range.start.line, call.range.start.line);
    });

    await check('clangd: outgoing calls use caller URI, direction switch keeps root', async () => {
      await controller.relations.setRoot(process, { manual: true });
      const rootName = controller.relations.root.name;
      await controller.navigation.setDirection('outgoing');
      assert.equal(controller.relations.root.name, rootName);
      const children = (await controller.relations.load(controller.relations.root, 'outgoing')).data;
      const callee = children.find(node => node.symbol.name.includes('leaf'));
      assert.ok(callee, 'clangd provides outgoing calls');
      assert.equal(callee.sites.length, 2);
      assert.ok(callee.sites.every(site => site.uri.toString() === document.uri.toString()));
    }, major > 0 && major < 20 ? 'clangd 20+ required for outgoing calls' : undefined);

    await check('clangd: recursive relation terminates at cycle', async () => {
      controller.relations.direction = 'incoming';
      await controller.relations.setRoot(recurse, { manual: true });
      const children = (await controller.relations.load(controller.relations.root, 'incoming')).data;
      const cycle = children.find(node => node.symbol.id === controller.relations.root.id);
      assert.ok(cycle);
      const node = controller.relationView.node(cycle.symbol, cycle.sites, [controller.relations.root.id]);
      assert.match(controller.relationView.children(node, 'incoming')[0].label, /递归/);
    });

    await check('clangd: references grouped with snippets and call-site preview', async () => {
      await controller.references.lookup(leaf);
      const group = controller.references.groups.find(node => node.uri.toString() === document.uri.toString());
      assert.ok(group);
      const children = await controller.references.getChildren(group);
      const reference = children.find(node => node.range.start.line === call.range.start.line);
      assert.ok(reference.snippet.includes('leaf(request.value)'));
      await controller.navigation.selectTarget(reference);
      assert.equal(controller.preview.current.mode, '引用现场');
      assert.equal(controller.preview.current.range.start.line, call.range.start.line);
      const count = controller.references.groups.length;
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await controller.follow.follow();
      assert.equal(controller.references.groups.length, count);
    });

    await check('reference filter/history and global-symbol search use the real language service', async () => {
      await controller.references.filter('reader.cpp');
      assert.ok(controller.references.allVisibleReferences().length);
      assert.ok(controller.references.allVisibleReferences().every(reference => path.basename(reference.uri.fsPath) === 'reader.cpp'));
      await controller.references.filter('');
      assert.ok(controller.references.recentSources.length);
      controller.pickers.symbols('leaf');
      await waitFor(async () => controller.pickers.active?.picker.items || [],
        items => items.some(item => item.label.includes('leaf')), 'workspace symbol picker');
      controller.pickers.close();
    });

    await check('Context: late definition response cannot replace newer selection', async () => {
      const delayed = deferred();
      const preview = new ContextView({
        definitions: sourceUri => sourceUri.toString() === main.uri.toString() ? delayed.promise : Promise.resolve([process])
      }, () => {});
      const old = preview.definition({ ...leaf, uri: main.uri });
      await preview.definition(process);
      delayed.resolve([leaf]); await old;
      assert.equal(preview.current.range.start.line, process.range.start.line);
      preview.dispose();
    });

    await check('Context: multiple definitions require an explicit candidate', async () => {
      const preview = new ContextView({ definitions: async () => [leaf, process] }, () => {});
      await preview.definition(leaf);
      assert.equal(preview.current, undefined);
      assert.equal(preview.state.candidates.length, 2);
      await preview.handleMessage({ action: 'candidate', index: 1 });
      assert.equal(preview.current.range.start.line, process.range.start.line);
      preview.dispose();
    });

    await check('symbols and references reject late sessions and retain full ranges', async () => {
      const delayed = deferred();
      const symbols = new SymbolTree({ symbols: sourceUri => sourceUri.toString() === main.uri.toString()
        ? delayed.promise : Promise.resolve(controller.symbols.nodes) });
      const old = symbols.load(main.uri);
      await symbols.load(document.uri); delayed.resolve([]); await old;
      assert.equal(symbols.uri.toString(), document.uri.toString());
      assert.ok(symbols.nodes.length); symbols.dispose();
      const references = new ReferencesTree({ references: async () => [leaf, leaf, process] });
      await references.lookup(leaf);
      // Production LanguageAdapter deduplicates provider results; this fake exercises tree grouping only.
      assert.equal(references.groups.length, 1);
      references.clear(); assert.equal(references.groups.length, 0); references.dispose();
    });

    await check('unsaved buffer updates preview and marks semantic results stale', async () => {
      await controller.preview.show({ ...leaf, mode: '定义' });
      controller.preview.toggleLock();
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(0, 0), '// unsaved preview test\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(300);
      assert.equal(controller.references.stale, true);
      assert.equal(controller.relations.rootState.status, 'stale');
      assert.match(controller.preview.state.status, /未保存|Unsaved text/);
      const undo = new vscode.WorkspaceEdit();
      undo.delete(document.uri, new vscode.Range(0, 0, 1, 0));
      await vscode.workspace.applyEdit(undo);
      await document.save();
      controller.preview.toggleLock();
    });

    await check('appearance: real C grammar and semantic colors distinguish macro and enum definitions from references', async () => {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'appearance.c');
      const source = '#define LIMIT 4\nenum Backoff { BMC_BACKOFF_UNSUPPORTED = 2 };\nint colors(void) {\n  return LIMIT + BMC_BACKOFF_UNSUPPORTED;\n}\n';
      fs.writeFileSync(uri.fsPath, source);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
      const workbench = vscode.workspace.getConfiguration('workbench');
      const oldTheme = workbench.inspect('colorTheme')?.workspaceValue;
      const oldFolding = vscode.workspace.getConfiguration('editor').get('showFoldingControls');
      const oldIcons = workbench.get('productIconTheme');
      try {
        await workbench.update('colorTheme', 'SourceInsight-Reader Source Insight', vscode.ConfigurationTarget.Workspace);
        const spans = await waitFor(() => controller.language.semanticTokens(uri, 'c'), spans => spans.length >= 5, 'macro and enum semantic classifications');
        const probes = [[0, 'LIMIT', 'macro', '#000080'], [1, 'BMC_BACKOFF_UNSUPPORTED', 'enumMember', '#000080'],
          [3, 'LIMIT', 'macro', '#c00000'], [3, 'BMC_BACKOFF_UNSUPPORTED', 'enumMember', '#c00000']];
        for (const [line, word, type, color] of probes) {
          const start = document.lineAt(line).text.indexOf(word);
          const span = spans.find(span => span.line === line && span.start === start);
          assert(span, `semantic token ${word} at line ${line}: ${JSON.stringify(spans)}`);
          assert.equal(span.type, type);
          assert.equal(require('../../src/preview-colors').semanticColor(span.type, span.modifiers, 'c'), color, `${word} at line ${line}, modifiers ${span.modifiers}`);
        }
        const lexical = await controller.language.textmateTokens(document, 0, 2);
        assert(lexical.length, 'VS Code built-in C grammar loads through the color Worker');
        const define = lexical.find(span => span.line === 0 && span.start <= 8 && span.end > 8);
        assert.equal(define.foreground.toLowerCase(), '#000080');
        await controller.preview.show({ uri, range: new vscode.Range(0, 0, 0, 0) });
        await waitFor(() => controller.preview.state, state => probes.every(([line, word, , color]) => {
          const row = state.lines.find(row => row.number === line + 1), at = document.lineAt(line).text.indexOf(word);
          let offset = 0;
          return row?.tokens.some(token => { const matched = offset === at && token.foreground?.toLowerCase() === color; offset += token.text.length; return matched; });
        }), 'Context uses blue definitions and red references at the same source positions');
        assert.equal(vscode.workspace.getConfiguration('editor').get('showFoldingControls'), oldFolding);
        assert.equal(workbench.get('productIconTheme'), oldIcons);
        const ranges = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', uri);
        assert(ranges?.length, 'Native folding ranges remain available');
      } finally { await workbench.update('colorTheme', oldTheme, vscode.ConfigurationTarget.Workspace); }
    });

    await check('settings: feature and appearance tabs share saving in the real host', async () => {
      const editor = vscode.workspace.getConfiguration('editor'), workbench = vscode.workspace.getConfiguration('workbench');
      const oldTokens = editor.inspect('semanticTokenColorCustomizations')?.workspaceValue;
      const oldPanes = config.inspect('appearance.panes')?.workspaceValue;
      const oldLines = config.inspect('contextLines')?.workspaceValue;
      const oldCacheDirectory = config.inspect('indexCacheDirectory')?.workspaceValue;
      const oldCpuLimit = config.inspect('indexCpuLimitPercent')?.workspaceValue;
      const cacheDirectory = path.join(path.dirname(vscode.workspace.workspaceFolders[0].uri.fsPath), 'feature-index-cache');
      const oldTheme = workbench.inspect('colorTheme')?.workspaceValue;
      try {
        await workbench.update('colorTheme', 'SourceInsight-Reader Source Insight', vscode.ConfigurationTarget.Workspace);
        const invalidCpu = await controller.appearancePanel.handle({ action: 'settingsSave', mode: 'workspace', query: JSON.stringify({ 'feature.indexCpuLimitPercent': '26' }) });
        assert(invalidCpu?.error, 'CPU budget above 25% must be rejected');
        const saved = await controller.appearancePanel.handle({ action: 'settingsSave', mode: 'workspace', query: JSON.stringify({
          'macro.reference': '#dd1122', 'context.background': '#efffef', 'relation.background': '#bbbbbb', 'relation.fontSize': '16', 'feature.contextLines': '30', 'feature.indexCacheDirectory': cacheDirectory, 'feature.indexCpuLimitPercent': '15'
        }) });
        assert(!saved?.error, saved?.error);
        const custom = vscode.workspace.getConfiguration('editor').get('semanticTokenColorCustomizations')['[SourceInsight-Reader Source Insight]'].rules;
        assert.equal(custom.macro.foreground, '#dd1122');
        assert.equal(vscode.workspace.getConfiguration('sourceInsightReader').get('appearance.panes').relation.fontSize, 16);
        assert.equal(vscode.workspace.getConfiguration('sourceInsightReader').get('contextLines'), 30);
        assert.equal(vscode.workspace.getConfiguration('sourceInsightReader').inspect('indexCacheDirectory').workspaceValue, cacheDirectory);
        assert.equal(vscode.workspace.getConfiguration('sourceInsightReader').get('indexCpuLimitPercent'), 15);
        await vscode.commands.executeCommand('sourceInsightReader.openSettings');
        assert(controller.appearancePanel.panel.webview.html.includes('id="tab-features"'));
        assert(controller.appearancePanel.panel.webview.html.includes('id="tab-appearance"'));
        assert(controller.appearancePanel.panel.webview.html.includes('id="save-reload"'));
        await sleep(1000); await captureUi('settings-features');
        await vscode.commands.executeCommand('sourceInsightReader.configureAppearance');
        assert(controller.appearancePanel.panel, 'Appearance webview opens');
        assert(controller.appearancePanel.panel.webview.html.includes('type="color"') || controller.appearancePanel.panel.webview.html.includes('appearance-panel.js'));
        await sleep(1200); await captureUi('appearance-settings');
      } finally {
        controller.appearancePanel.panel?.dispose();
        await editor.update('semanticTokenColorCustomizations', oldTokens, vscode.ConfigurationTarget.Workspace);
        await config.update('appearance.panes', oldPanes, vscode.ConfigurationTarget.Workspace);
        await config.update('contextLines', oldLines, vscode.ConfigurationTarget.Workspace);
        await config.update('indexCacheDirectory', oldCacheDirectory, vscode.ConfigurationTarget.Workspace);
        await config.update('indexCpuLimitPercent', oldCpuLimit, vscode.ConfigurationTarget.Workspace);
        await workbench.update('colorTheme', oldTheme, vscode.ConfigurationTarget.Workspace);
      }
    });

    await check('commercial reading: real local references, multiline search, anchored bookmark and diagnostics', async () => {
      const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'commercial-reading.c');
      fs.writeFileSync(uri.fsPath, 'int saved_value;\nint reader(void) {\n  return saved_value;\n}\n');
      const doc = await vscode.workspace.openTextDocument(uri);
      await controller.localIndex.refresh(true);
      const refs = await controller.localIndex.references(uri, new vscode.Position(0, 5));
      assert.equal(refs.locations.length, 2);
      await sleep(750);
      await controller.textLookup.search('reader\\(void\\) \\{\\s+return', controller.textSession.roots()[0], { regex: true, multiline: true });
      assert(controller.textLookup.rows.some(row => row.uri.toString() === uri.toString() && row.range.end.line > row.range.start.line), JSON.stringify({ message: controller.textLookup.message, stats: controller.textLookup.stats, rows: controller.textLookup.rows.length }));
      const saved = controller.tools.capture({ uri, range: new vscode.Range(2, 2, 2, 2) });
      const edit = new vscode.WorkspaceEdit(); edit.insert(uri, new vscode.Position(0, 0), '// added\n');
      await vscode.workspace.applyEdit(edit);
      assert.equal((await controller.tools.resolve(saved)).range.start.line, 3);
      const report = await controller.tools.diagnostics();
      assert.equal(report.index.enabled, true); assert(!JSON.stringify(report).includes(uri.fsPath));
      await doc.save();
    });

    await check('all declared commands registered and workbench views can open', async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const command of extension.packageJSON.contributes.commands) assert.ok(commands.includes(command.command), command.command);
      await vscode.commands.executeCommand('sourceInsightReader.open');
      await sleep(800);
      assert.ok(controller.readingPanel.port, 'Combined reading webview resolved');
      if (globalThis.process.env.SOURCEINSIGHT_READER_CAPTURE_UI === '1') {
        const workbench = vscode.workspace.getConfiguration('workbench'), theme = workbench.inspect('colorTheme')?.workspaceValue;
        try {
          await workbench.update('colorTheme', 'SourceInsight-Reader Source Insight', vscode.ConfigurationTarget.Workspace);
          await vscode.window.showTextDocument(document);
          await controller.preview.show(leaf);
          await controller.relations.setRoot(leaf, { manual: true });
          await sleep(1500); await captureUi('reading-appearance');
          await vscode.commands.executeCommand('editor.fold', { selectionLines: [leaf.range.start.line] });
          await sleep(250); await captureUi('reading-folded');
          await vscode.commands.executeCommand('editor.unfoldAll');
        } finally { await workbench.update('colorTheme', theme, vscode.ConfigurationTarget.Workspace); }
      }
    });
    completed = true;
  } finally {
    await config.update('autoPreview', oldAutoPreview, vscode.ConfigurationTarget.Workspace);
    await config.update('autoRelation', oldAutoRelation, vscode.ConfigurationTarget.Workspace);
    if (process.env.SOURCEINSIGHT_READER_REPORT) {
      fs.mkdirSync(path.dirname(process.env.SOURCEINSIGHT_READER_REPORT), { recursive: true });
      fs.writeFileSync(process.env.SOURCEINSIGHT_READER_REPORT, JSON.stringify({
        vscode: vscode.version, platform: process.platform, installation: process.env.SOURCEINSIGHT_READER_INSTALLATION, completed, results, passed: results.filter(result => result.passed).length,
        skipped: results.filter(result => result.skipped).length
      }, null, 2));
    }
  }
  console.log(`${results.filter(result => result.passed).length} extension-host checks passed; ${results.filter(result => result.skipped).length} skipped.`);
}

module.exports = { run };
