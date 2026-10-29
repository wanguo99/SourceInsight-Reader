'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: immediate } = require('node:timers/promises');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

function fixture() {
  const env = fakeVscode(), values = new Map(), doc = env.document('notes.c', 'int before;\nint target;\nint after;');
  env.context.workspaceState = { get: (key, fallback) => values.get(key) ?? fallback,
    update: async (key, value) => { await immediate(); values.set(key, value); } };
  const source = { uri: doc.uri, range: new env.api.Range(1, 4, 1, 10), name: 'target' };
  const app = { context: env.context, catalog: { document: () => doc, accepts: () => true },
    navigation: { source: () => source }, preview: {}, relations: {}, symbols: { query: '' }, textLookup: {} };
  const { ReaderTools } = loadWithVscode('../src/features/reader-tools', env.api);
  const tools = new ReaderTools(app);
  const original = { ...tools.capture(source), id: 'original', note: 'original note' };
  values.set('reader.bookmarks', [original]);
  return { env, values, doc, tools, original };
}

test('editing or deleting a bookmark preserves bookmarks added while its picker was open', async () => {
  for (const action of ['编辑笔记', '删除']) {
    const { env, values, tools, original } = fixture();
    const added = { ...original, id: 'added', note: 'new note' };
    let step = 0;
    env.api.window.showQuickPick = async choices => {
      if (++step === 1) return choices[0];
      values.set('reader.bookmarks', [original, added]);
      return action;
    };
    env.api.window.showInputBox = async () => 'edited note';
    await tools.bookmarks();
    assert.deepEqual(values.get('reader.bookmarks').find(item => item.id === 'added'), added);
    const current = values.get('reader.bookmarks').find(item => item.id === 'original');
    if (action === '删除') assert.equal(current, undefined);
    else assert.equal(current.note, 'edited note');
  }
});

test('simultaneous bookmark saves serialize asynchronous storage writes', async () => {
  const { env, values, tools } = fixture();
  env.api.window.showInputBox = async () => 'new note';
  await Promise.all([tools.addBookmark(), tools.addBookmark()]);
  const bookmarks = values.get('reader.bookmarks');
  assert.equal(bookmarks.length, 3);
  assert.equal(new Set(bookmarks.map(item => item.id)).size, 3);
});

test('an old note editor cannot overwrite a changed or deleted bookmark', async () => {
  for (const changed of [true, false]) {
    const { env, values, tools, original } = fixture();
    let step = 0;
    env.api.window.showQuickPick = async choices => ++step === 1 ? choices[0] : '编辑笔记';
    const latest = changed ? [{ ...original, note: 'newer edit' }] : [];
    env.api.window.showInputBox = async () => { values.set('reader.bookmarks', latest); return 'old edit'; };
    await assert.rejects(tools.bookmarks(), /书签.*(改变|修改|删除)/);
    assert.deepEqual(values.get('reader.bookmarks'), latest);
  }
});

test('failed storage writes do not prevent a later bookmark save', async () => {
  const { env, values, tools } = fixture();
  let fail = true;
  tools.state.update = async (key, value) => { if (fail) { fail = false; throw new Error('storage unavailable'); } values.set(key, value); };
  env.api.window.showInputBox = async () => 'note';
  await assert.rejects(tools.addBookmark(), /storage unavailable/);
  await tools.addBookmark();
  assert.equal(values.get('reader.bookmarks').length, 2);
});

test('saving a reading task anchors the original source before the name prompt', async () => {
  const { env, values, tools, doc } = fixture();
  env.api.window.showInputBox = async () => { doc.text = '// inserted\n' + doc.text; doc.version++; return 'review'; };
  await tools.saveTask();
  const saved = values.get('reader.tasks')[0];
  const restored = await tools.resolve(saved.main);
  assert.equal(restored.range.start.line, 2);
  assert.match(doc.lineAt(restored.range.start.line).text, /target/);
});


test('invalid stored reading data is preserved until the user explicitly confirms clearing it', async () => {
  const { env, values, tools } = fixture(), damaged = { unexpected: 'preserve until confirmed' };
  values.set('reader.bookmarks', damaged);
  env.api.window.showInputBox = async () => 'note';
  await assert.rejects(tools.addBookmark(), /阅读数据格式无效/);
  assert.equal(values.get('reader.bookmarks'), damaged);
  env.api.window.showQuickPick = async choices => [choices[0]];
  env.api.window.showWarningMessage = async () => undefined;
  await tools.clearData();
  assert.equal(values.get('reader.bookmarks'), damaged);
  env.api.window.showWarningMessage = async () => '删除';
  await tools.clearData();
  assert.deepEqual(values.get('reader.bookmarks'), []);
});
