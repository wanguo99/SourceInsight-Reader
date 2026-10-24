'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
function setup() {
  const env = fakeVscode(), cache = new Map();
  env.settings.set('sourceInsightReader.autoConfigureClangd', true);
  const load = name => loadWithVscode(require.resolve(name), env.api, cache);
  const { ReadingScope } = load('../src/infrastructure/reading-scope');
  return { env, scope: new ReadingScope(), ...load('../src/infrastructure/clangd-scope') };
}
test('clangd scope excludes outside peer directories and escapes literal path regex characters', () => {
  const s = setup();
  s.env.settings.set('sourceInsightReader.excludedDirectories', ['linux/build.v1']);
  const fragment = s.scopeFragment(s.scope, s.env.api.workspace.workspaceFolders[0]);
  assert.doesNotMatch(fragment, /PathExclude/);
  const excluded = JSON.parse(fragment.split('PathMatch: ')[1].split('\n')[0])[0];
  assert.equal(new RegExp('^(?:' + excluded + ')$').test('linux/build.v1/a.c'), true);
  assert.equal(new RegExp('^(?:' + excluded + ')$').test('linux/buildXv1/a.c'), false);
  assert.equal(fragment.includes('Background: Build'), false);
});
test('managed clangd rules are idempotent and removal restores original contents', () => {
  const s = setup(), original = 'CompileFlags:\n  Add: [-DTEST]\n';
  const managed = s.replaceManaged(original, 'Index:\n  Background: Skip');
  assert.equal(s.replaceManaged(managed, 'Index:\n  Background: Skip'), managed);
  assert.equal(s.replaceManaged(managed, ''), original);
  assert.throws(() => s.replaceManaged('# BEGIN SourceInsight-Reader managed index scope', ''), /标记不完整/);
});
test('automatic clangd synchronization preserves compile flags, removes rules when disabled and respects dirty files', async () => {
  const s = setup();
  s.env.api.workspace.isTrusted = true;
  s.env.api.workspace.textDocuments = [];
  s.env.settings.set('sourceInsightReader.excludedDirectories', ['build']);
  let contents = 'CompileFlags:\n  Add: [-DTEST]\n', writes = 0;
  s.env.api.workspace.fs.readFile = async () => Buffer.from(contents);
  s.env.api.workspace.fs.writeFile = async (uri, bytes) => { contents = bytes.toString(); writes++; };
  const manager = new s.ClangdScope({ scope: s.scope, onDidChange: () => ({ dispose() {} }) }, () => {});
  await manager.pending;
  assert.match(contents, /PathMatch/); assert.match(contents, /-DTEST/);
  await manager.schedule(); assert.equal(writes, 1);
  s.env.api.workspace.textDocuments = [{ isDirty: true, uri: s.env.api.Uri.file('/project/.clangd') }];
  manager.report = () => {};
  s.env.settings.set('sourceInsightReader.autoConfigureClangd', false);
  await manager.schedule(); assert.equal(writes, 1);
  s.env.api.workspace.textDocuments = [];
  await manager.schedule(); assert.equal(contents, 'CompileFlags:\n  Add: [-DTEST]\n');
  manager.dispose();
});
test('managed block preserves CRLF, BOM, no final newline and refuses duplicate markers', () => {
  const s = setup();
  for (const original of ['', '\uFEFFCompileFlags:\r\n  Add: [-DTEST]\r\n', 'CompileFlags:\n  Add: [-DTEST]', '# comment\r\n']) {
    const managed = s.replaceManaged(original, 'Index:\n  Background: Skip');
    assert.equal(s.replaceManaged(managed, ''), original);
    assert.equal(s.replaceManaged(managed, 'Index:\n  Background: Skip'), managed);
  }
  const managed = s.replaceManaged('', 'Index:\n  Background: Skip');
  assert.throws(() => s.replaceManaged(managed + managed, ''), /重复/);
});
test('a failing workspace root does not block configuration of other workspace roots', async () => {
  const s = setup();
  s.env.api.workspace.isTrusted = true;
  s.env.api.workspace.workspaceFolders.push({ uri: s.env.api.Uri.file('/other'), name: 'other', index: 1 });
  s.env.settings.set('sourceInsightReader.excludedDirectories', ['build']);
  const written = [], reports = [];
  s.env.api.window.showWarningMessage = () => {};
  s.env.api.workspace.fs.readFile = async uri => {
    if (uri.path.startsWith('/project/')) throw Object.assign(new Error('read only'), { code: 'NoPermissions' });
    return Buffer.from('');
  };
  s.env.api.workspace.fs.writeFile = async uri => written.push(uri.path);
  const manager = new s.ClangdScope({ scope: s.scope, onDidChange: () => ({ dispose() {} }) }, message => reports.push(message));
  await manager.pending;
  assert.deepEqual(written, ['/other/.clangd']);
  assert.ok(reports.some(message => message.includes('read only')));
  manager.dispose();
});
test('clangd sync never writes in untrusted workspaces or over a buffer dirtied during a read', async () => {
  const s = setup();
  s.env.settings.set('sourceInsightReader.excludedDirectories', ['build']);
  let reads = 0, writes = 0;
  s.env.api.workspace.isTrusted = false;
  s.env.api.workspace.fs.readFile = async () => {
    reads++;
    s.env.api.workspace.textDocuments = [{ isDirty: true, uri: s.env.api.Uri.file('/project/.clangd') }];
    return Buffer.from('');
  };
  s.env.api.workspace.fs.writeFile = async () => writes++;
  const manager = new s.ClangdScope({ scope: s.scope, onDidChange: () => ({ dispose() {} }) }, () => {});
  await manager.pending; assert.equal(reads, 0);
  s.env.api.workspace.isTrusted = true;
  await manager.schedule(); assert.equal(reads, 1); assert.equal(writes, 0);
  manager.dispose();
});
test('generated YAML is accepted by real clangd without configuration diagnostics', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const execute = require('node:util').promisify(require('node:child_process').execFile);
  const executable = process.env.CLANGD_PATH || 'clangd';
  try { await execute(executable, ['--version'], { timeout: 5000 }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; t.skip('clangd unavailable'); return; }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sir-config-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const s = setup();
  s.env.api.workspace.workspaceFolders = [{ uri: s.env.api.Uri.file(temporary), name: 'project', index: 0 }];
  s.env.settings.set('sourceInsightReader.excludedFiles', ['src/other.c']);
  s.env.settings.set('sourceInsightReader.excludedDirectories', ['src/generated']);
  fs.mkdirSync(path.join(temporary, 'src'));
  const file = path.join(temporary, 'src/main.c');
  fs.writeFileSync(file, 'int main(void) { return 0; }\n');
  for (const original of ['', 'CompileFlags:\n  Add: [-DTEST]\n']) {
    fs.writeFileSync(path.join(temporary, '.clangd'), s.replaceManaged(original, s.scopeFragment(s.scope, s.env.api.workspace.workspaceFolders[0])));
    const result = await execute(executable, ['--check=' + file, '--enable-config', '--log=verbose'], { encoding: 'utf8', timeout: 15000 });
    assert.doesNotMatch(result.stderr, /config (?:error|warning)/i);
  }
});

test('clangd file exclusions use an exact escaped path rather than a directory subtree rule', () => {
  const s = setup();
  s.env.settings.set('sourceInsightReader.excludedFiles', ['src/file[1].c']);
  const fragment = s.scopeFragment(s.scope, s.env.api.workspace.workspaceFolders[0]);
  const patterns = JSON.parse(fragment.split('PathMatch: ')[1].split('\n')[0]);
  const regex = new RegExp('^(?:' + patterns[0] + ')$');
  assert(regex.test('src/file[1].c'));
  assert(!regex.test('src/file1.c'));
  assert(!regex.test('src/file[1].cpp'));
  assert(!regex.test('src/file[1].c/other'));
});

test('clangd opt-in previews all roots and backs up originals before managed writes', async () => {
  const s = setup(), contents = new Map([['/project/.clangd', 'CompileFlags:\n  Add: [-DUSER]\n']]);
  s.env.api.workspace.isTrusted = true; s.env.settings.set('sourceInsightReader.autoConfigureClangd', false);
  s.env.settings.set('sourceInsightReader.excludedDirectories', ['build']);
  s.env.context.storageUri = s.env.api.Uri.file('/storage');
  s.env.api.workspace.fs.readFile = async uri => { if (!contents.has(uri.path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return Buffer.from(contents.get(uri.path)); };
  s.env.api.workspace.fs.stat = async uri => { if (!contents.has(uri.path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return {}; };
  s.env.api.workspace.fs.createDirectory = async () => {};
  s.env.api.workspace.fs.writeFile = async (uri, bytes) => { contents.set(uri.path, bytes.toString()); };
  let diff = false;
  s.env.commands.set('vscode.diff', () => { diff = true; });
  s.env.api.window.showQuickPick = async choices => { assert(diff); return choices[0]; };
  const manager = new s.ClangdScope({ scope: s.scope, onDidChange: () => ({ dispose() {} }) }, () => {}, s.env.context);
  await manager.pending; assert(![...contents.keys()].some(value => value.includes('backups')));
  await manager.configure();
  assert.match(contents.get('/project/.clangd'), /Background: Skip/);
  assert.equal([...contents.entries()].find(([name]) => name.endsWith('.original'))[1], 'CompileFlags:\n  Add: [-DUSER]\n');
  contents.set('/project/.clangd', contents.get('/project/.clangd') + '# new user note\n');
  await manager.configure(false);
  assert.equal(contents.get('/project/.clangd'), 'CompileFlags:\n  Add: [-DUSER]\n# new user note\n'); manager.dispose();
});
