'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function setup(limits) {
  const env = fakeVscode(), disk = new Map();
  env.api.workspace.findFiles = async () => [...disk.keys()].map(uri => env.api.Uri.parse(uri));
  env.api.workspace.fs.readFile = async uri => {
    if (!disk.has(uri.toString())) throw new Error('unavailable'); return disk.get(uri.toString());
  };
  const { WorkspaceFileCatalog } = loadWithVscode('../src/infrastructure/workspace-file-catalog', env.api);
  const mod = loadWithVscode('../src/text-lookup', env.api);
  const model = new mod.TextLookup(new WorkspaceFileCatalog(), async () => [], limits);
  const add = (name, text) => {
    const doc = env.document(name, typeof text === 'string' ? text : '');
    disk.set(doc.uri.toString(), typeof text === 'string' ? Buffer.from(text) : text); return doc;
  };
  return { env, disk, model, add, ...mod };
}

test('literal matching preserves CRLF and UTF-16 positions, supports substring, Unicode boundaries and case options', () => {
  const s = setup(), { findMatches } = s;
  const text = '😀 value VALUE value_more _value value2\r\n// value value\r\n"a.b" aXb';
  const rows = findMatches(text, 'value'); assert.equal(rows.length, 7);
  assert.equal(rows[0].start, 3); assert.equal(rows[5].line, 1); assert.equal(rows[6].start, 9);
  assert.equal(findMatches(text, 'value', { wholeWord: true }).length, 4);
  assert.equal(findMatches(text, 'value', { matchCase: true }).length, 6);
  assert.equal(findMatches(text, 'a.b').length, 1);
  assert.equal(findMatches('变量 变量名 _变量 变量2', '变量', { wholeWord: true }).length, 1);
  assert.equal(findMatches('İ value', 'value')[0].start, 2);
  assert.equal(findMatches('x\ny', 'x\ny').length, 0);
  assert.equal(findMatches('x x x', 'x', {}, 2).length, 2);
  s.model.dispose();
});

test('folder text lookup includes dirty buffers and comment/string matches, filters scope/excludes and labels enclosing C functions', async () => {
  const s = setup();
  const a = s.add('src/a.c', 'int target;\nint main() { target(); target_more(); }\n// target\n"target"');
  const b = s.add('src/b.c', 'int no_match;'); b.text = 'int target;'; b.isDirty = true;
  s.add('node_modules/vendor.c', 'target'); s.add('generated/code.c', 'target'); s.add('skip/code.c', 'target');
  s.add('binary.bin', Buffer.from([0, 1, 2, 100]));
  const outside = s.env.api.Uri.file('/another/out.c'); s.disk.set(outside.toString(), Buffer.from('target'));
  s.env.settings.set('files.exclude', { '**/generated': true });
  s.env.settings.set('search.exclude', { '**/skip': true, '**/generated': false });
  s.env.api.workspace.textDocuments = [b];
  s.model.symbols = async uri => uri.toString() === a.uri.toString() ? [{ name: 'main', kind: 11, children: [], range: new s.env.api.Range(1, 0, 2, 0) }] : [];
  await s.model.search('target', s.env.api.workspace.workspaceFolders[0]);
  assert.equal(s.model.rows.length, 6); assert.equal(s.model.stats.files, 2);
  assert.equal(s.model.rows.filter(row => row.owner === 'main').length, 2);
  assert.equal(s.model.rows.at(-1).lineText, 'int target;'); assert.equal(s.model.stats.skipped, 1);
  assert.equal(await s.model.validate(s.model.rows.at(-1)), true);
  b.text = 'shifted target;'; b.version++;
  assert.equal(await s.model.validate(s.model.rows.at(-1)), false); assert.equal(s.model.stale, true);
  s.model.dispose();
});

test('new searches cancel old scans and file changes prevent stale navigation', async () => {
  const s = setup(); const doc = s.add('a.c', 'old new'); let resolveOld;
  s.env.api.workspace.findFiles = () => new Promise(resolve => { resolveOld = resolve; });
  const old = s.model.search('old', s.env.api.workspace.workspaceFolders[0]);
  s.env.api.workspace.findFiles = async () => [doc.uri];
  await s.model.search('new', s.env.api.workspace.workspaceFolders[0]);
  resolveOld([doc.uri]); await old;
  assert.equal(s.model.query, 'new'); assert.equal(s.model.rows.length, 1); assert.equal(s.model.rows[0].match, 'new');
  s.env.events.change.fire(doc.uri); assert.equal(s.model.stale, true);
  assert.equal(await s.model.validate(s.model.rows[0]), false);
  s.model.dispose();
});

test('search bounds and failures are explicit, never presented as complete results', async () => {
  const s = setup({ matches: 2, bytes: 50 });
  s.add('a.c', 'x x x x'); s.add('huge.c', 'x'.repeat(100));
  await s.model.search('x', s.env.api.workspace.workspaceFolders[0]);
  assert.equal(s.model.rows.length, 2); assert.match(s.model.message, /结果不完整/);
  await s.model.search('x', undefined); assert.match(s.model.message, /工作区文件夹/);
  s.env.api.workspace.findFiles = async () => { throw new Error('read error'); };
  await s.model.search('x', s.env.api.workspace.workspaceFolders[0]); assert.match(s.model.message, /检索失败/);
  s.model.dispose();
});

test('unsaved new files are searched and UTF-16 BOM files use the editor-decoded text', async () => {
  const s = setup();
  const wide = s.add('wide.c', Buffer.from([0xff, 0xfe, 0x76, 0, 0x61, 0])); wide.text = '变量 value';
  const unsaved = s.env.document('new.c', 'value'); unsaved.isDirty = true;
  s.env.api.workspace.textDocuments = [unsaved];
  await s.model.search('value', s.env.api.workspace.workspaceFolders[0]);
  assert.equal(s.model.rows.length, 2); assert(s.model.rows.some(row => row.uri.toString() === unsaved.uri.toString()));
  assert.equal(s.model.rows.find(row => row.uri.toString() === wide.uri.toString()).start, 3);
  s.model.dispose();
});

test('current folder selection chooses the deepest root and handles Windows URI casing', () => {
  const s = setup();
  s.env.api.workspace.workspaceFolders = [
    { name: 'outer', uri: s.env.api.Uri.parse('file:///C:/Project') },
    { name: 'nested', uri: s.env.api.Uri.parse('file:///C:/Project/Modules') }
  ];
  assert.equal(s.folderFor(s.env.api.Uri.parse('file:///c:/project/modules/目录/a.c')).name, 'nested');
  assert.equal(s.folderFor(s.env.api.Uri.parse('file:///D:/other/a.c')), undefined);
  s.model.dispose();
});
