'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
test('reference session filters, previews exact locations, paginates all results and rejects stale rows and document versions', async t => {
  const env = fakeVscode(), cache = new Map(), load = file => loadWithVscode(require.resolve(file), env.api, cache);
  const { ReferencesTree } = load('../src/trees'), { ReferenceSearchSession } = load('../src/features/search-sessions');
  const doc = env.document('ref.c', 'int value;\nint read() { return value; }\n');
  const range = new env.api.Range(1, 20, 1, 25), source = { uri: doc.uri, range, name: 'value' };
  const model = new ReferencesTree({ references: async () => [source] }), opened = [], previewed = [];
  const session = new ReferenceSearchSession(model, node => opened.push(node), node => previewed.push(node), () => {});
  t.after(() => { session.dispose(); model.dispose(); });
  await model.lookup(source); const state = await session.snapshot(), row = state.rows[0];
  await session.handle({ action: 'open', id: row.id, generation: state.generation }); assert.equal(opened[0].range, range);
  await session.handle({ action: 'preview', id: row.id, generation: state.generation }); assert.equal(previewed.length, 1);
  await session.handle({ action: 'search', query: 'missing' }); assert.equal((await session.snapshot()).rows.length, 0);
  await session.handle({ action: 'open', id: row.id, generation: state.generation }); assert.equal(opened.length, 1);
  await session.handle({ action: 'search', query: 'return value' }); const filtered = await session.snapshot(); assert.match(filtered.rows[0].before + filtered.rows[0].matched + filtered.rows[0].after, /return value/);
  assert.equal(filtered.rows[0].matched, 'value');
  doc.version++; await session.handle({ action: 'open', id: filtered.rows[0].id, generation: filtered.generation }); assert.equal(model.stale, true); assert.equal(opened.length, 1);
  model.language.references = async () => Array.from({ length: 401 }, (_, n) => ({ uri: doc.uri, range: new env.api.Range(n, 0, n, 1) }));
  await model.filter(''); await model.lookup(source); assert.equal((await session.snapshot()).rows.length, 300);
  await session.handle({ action: 'pageNext' }); assert.equal((await session.snapshot()).rows.length, 101);
  await session.handle({ action: 'clear' }); assert.equal((await session.snapshot()).rows.length, 0);
});

test('reference rows share document symbols and show the enclosing function with an exact highlighted hit', async t => {
  const env = fakeVscode(), cache = new Map(), load = file => loadWithVscode(require.resolve(file), env.api, cache);
  const { ReferencesTree } = load('../src/trees'), { ReferenceSearchSession } = load('../src/features/search-sessions');
  const doc = env.document('owner.c', 'int value;\nint read() { return value + value; }');
  const rows = [20, 28].map(column => ({ uri: doc.uri, range: new env.api.Range(1, column, 1, column + 5) }));
  const model = new ReferencesTree({ references: async () => rows }); let queries = 0;
  const session = new ReferenceSearchSession(model, async () => {}, async () => {}, () => {}, async () => {
    queries++; return [{ name: 'read', kind: 11, range: new env.api.Range(1, 0, 1, 35), children: [] }];
  });
  t.after(() => { session.dispose(); model.dispose(); });
  await model.lookup({ ...rows[0], name: 'value' });
  const result = await session.snapshot(); assert.equal(queries, 1);
  assert.deepEqual(result.rows.map(row => row.owner), ['read', 'read']);
  assert.deepEqual(result.rows.map(row => row.matched), ['value', 'value']);
  await session.snapshot(); assert.equal(queries, 1);
});
