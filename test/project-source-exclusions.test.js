'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function fixture() {
  const env = fakeVscode(), cache = new Map();
  const load = name => loadWithVscode(require.resolve(name), env.api, cache);
  const { ReadingScope } = load('../src/infrastructure/reading-scope');
  const scope = new ReadingScope();
  const selection = { mode: 'selected', directories: ['src', 'src/skip/keep'], files: ['src/skip/one.c'],
    excludedDirectories: ['src/skip'], excludedFiles: ['src/skip/keep/private.c'] };
  env.settings.set('sourceInsightReader.projectSources', selection);
  const has = path => scope.contains(env.api.Uri.file('/project/' + path));
  return { env, scope, selection, has, load };
}

test('import exclusions preserve parent inclusion, nested re-inclusions, new files and cache isolation', () => {
  const s = fixture();
  assert.equal(s.has('src/main.c'), true);
  assert.equal(s.has('src/future/new.c'), true);
  assert.equal(s.has('src/skip/a.c'), false);
  assert.equal(s.has('src/skip/one.c'), true);
  assert.equal(s.has('src/skip/keep/public.c'), true);
  assert.equal(s.has('src/skip/keep/private.c'), false);
  assert.equal(s.has('src/skipper/a.c'), true);
  assert.equal(s.has('outside.c'), false);
  const key = s.scope.key();
  s.env.settings.set('sourceInsightReader.projectSources', { ...s.selection, excludedFiles: ['src/main.c'] });
  assert.notEqual(s.scope.key(), key);
  assert.equal(s.has('src/main.c'), false);
});

test('import selections cannot override global exclusions, and malformed or foreign exclusions fail closed', () => {
  const s = fixture();
  s.env.settings.set('sourceInsightReader.excludedDirectories', ['src/skip/keep']);
  assert.equal(s.has('src/skip/keep/public.c'), false);
  for (const excludedDirectories of ['bad-shape', ['/foreign'], [null]]) {
    s.env.settings.set('sourceInsightReader.projectSources', { ...s.selection, excludedDirectories });
    assert(s.scope.snapshot().error);
    assert.equal(s.has('src/main.c'), false);
  }
});

test('catalog enumerates explicit re-inclusions while pruning excluded directory trees', async t => {
  const s = fixture(), enumerated = [];
  s.env.api.workspace.fs.stat = async uri => ({ type: /\.c$/.test(uri.path) ? 1 : 2 });
  s.env.api.workspace.findFiles = async (pattern, exclude) => {
    enumerated.push({ root: pattern.baseUri.path, exclude });
    return ['/project/src/main.c', '/project/src/skip/a.c', '/project/src/skip/keep/public.c', '/project/src/skip/keep/private.c'].map(path => s.env.api.Uri.file(path));
  };
  const catalog = new (s.load('../src/infrastructure/workspace-file-catalog').WorkspaceFileCatalog)();
  t.after(() => catalog.dispose());
  assert.deepEqual((await catalog.list()).map(uri => uri.path).sort(), ['/project/src/main.c', '/project/src/skip/keep/public.c', '/project/src/skip/one.c'].sort());
  assert(enumerated.find(call => call.root === '/project/src').exclude.includes('skip/**'));
  assert(enumerated.some(call => call.root === '/project/src/skip/keep'));
});

test('managed clangd scope agrees with imported parent exclusions and explicit descendant restores', () => {
  const s = fixture();
  const { scopeFragment } = s.load('../src/infrastructure/clangd-scope');
  const fragment = scopeFragment(s.scope, s.env.api.workspace.workspaceFolders[0]);
  const skipped = path => fragment.split('\n---\n').some(part => {
    const fields = [...part.matchAll(/Path(Match|Exclude): ([^\n]+)/g)];
    return fields.every(([, kind, json]) => {
      const value = JSON.parse(json), expressions = Array.isArray(value) ? value : [value];
      const matches = expressions.some(pattern => new RegExp('^(?:' + pattern + ')$').test(path));
      return kind === 'Match' ? matches : !matches;
    });
  });
  for (const [path, included] of [['src/main.c', true], ['src/skip/a.c', false], ['src/skip/one.c', true], ['src/skip/keep/public.c', true], ['src/skip/keep/private.c', false], ['outside.c', false]]) {
    assert.equal(!skipped(path), included, path);
    assert.equal(s.has(path), included, path);
  }
});


test('import exclusion matching respects Windows path identity, remote authorities and component boundaries', () => {
  const s = fixture(), root = s.env.api.Uri.file('C:/Work/Source');
  s.env.api.workspace.workspaceFolders = [{ uri: root, name: 'source' }];
  s.env.settings.set('sourceInsightReader.projectSources', { mode: 'selected', directories: ['.'], files: [], excludedDirectories: ['Skip'], excludedFiles: ['exact.c'] });
  assert.equal(s.scope.contains(s.env.api.Uri.file('c:/work/source/skip/hidden.c')), false);
  assert.equal(s.scope.contains(s.env.api.Uri.file('C:/Work/Source/Skipper/main.c')), true);
  assert.equal(s.scope.contains(s.env.api.Uri.file('C:/Work/Source/exact.cpp')), true);
  assert.equal(s.scope.contains(s.env.api.Uri.file('C:/Work/Source/EXACT.c')), false);
  assert.equal(s.scope.contains(s.env.api.Uri.parse('vscode-remote://other/C:/Work/Source/keep.c')), false);
});


test('an explicit exclusion wins over a conflicting import at the same path in both scope and clangd', () => {
  const s = fixture();
  s.selection.files.push('src/skip/keep/private.c');
  const { scopeFragment } = s.load('../src/infrastructure/clangd-scope');
  const fragment = scopeFragment(s.scope, s.env.api.workspace.workspaceFolders[0]);
  assert.equal(s.has('src/skip/keep/private.c'), false);
  const last = fragment.split('\n---\n').at(-1);
  assert.match(last, /private/);
  assert.doesNotMatch(last, /PathExclude/, 'A same-path positive import cannot cancel its explicit exclusion');
});
