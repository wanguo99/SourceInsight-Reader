'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
function setup(options = {}) {
  const env = fakeVscode(), doc = env.document('calls.c'), calls = [], logs = [];
  const range = new env.api.Range(0, 4, 0, 8);
  const item = { name: 'root', uri: doc.uri, range, selectionRange: range };
  const localItem = { ...item, sourceInsightInspiredLocal: { id: 'local-root' } };
  const local = { revision: 1, status: '本地 C 索引：就绪', enabled: () => true, supports: uri => /\.[ch]$/i.test(uri.path),
    describe: () => ({ state: 'ready', note: '本地 C 索引：就绪' }), prepare: async () => [localItem], calls: async () => [], log: message => logs.push(message) };
  const { RelationBackend } = loadWithVscode('../src/relation-backend', env.api);
  const engine = new RelationBackend(local, async (command, ...args) => { calls.push({ command, args }); return command === 'vscode.prepareCallHierarchy' ? [item] : []; }, options);
  return { env, doc, range, item, localItem, local, engine, calls, logs };
}
const hang = () => new Promise(() => {});

test('C roots and edges use local index; semantic roots can use a newly available local index', async () => {
  const s = setup();
  s.local.calls = async (root, direction) => {
    assert.equal(root, s.localItem); return [{ [direction === 'incoming' ? 'from' : 'to']: { ...s.item, name: 'edge' }, fromRanges: [s.range] }];
  };
  const roots = await s.engine.prepare(s.doc.uri, s.range.start, 'root');
  assert.equal(roots.relationStatus.backend, 'local');
  for (const direction of ['incoming', 'outgoing']) {
    const values = await s.engine.calls(s.item, direction); assert.equal(values.length, 1); assert.equal(values.relationStatus.backend, 'local');
  }
  assert.equal(s.calls.length, 0); s.engine.dispose();
});

test('each edge direction retries local lookup after a real language-service timeout', async () => {
  for (const direction of ['incoming', 'outgoing']) {
    const s = setup({ timeoutMs: 5, localTimeoutMs: 10 });
    let ready = false;
    s.local.prepare = async () => ready ? [s.localItem] : [];
    s.local.calls = async () => [{ [direction === 'incoming' ? 'from' : 'to']: s.item, fromRanges: [s.range] }];
    s.engine.execute = async command => { ready = true; return hang(); };
    const values = await s.engine.calls(s.item, direction);
    assert.equal(values.length, 1); assert.equal(values.relationStatus.backend, 'local');
    assert.match(values.relationStatus.note, /已回退.*超时/); s.engine.dispose();
  }
});

test('local provider failure re-prepares a semantic root without passing local data to language services', async () => {
  const s = setup(); s.local.calls = async () => { throw new Error('worker unavailable'); };
  s.engine.execute = async (command, root) => {
    s.calls.push(command);
    if (command === 'vscode.prepareCallHierarchy') return [s.item];
    assert.equal(root.sourceInsightInspiredLocal, undefined); return [{ to: s.item, fromRanges: [s.range] }];
  };
  const values = await s.engine.calls(s.localItem, 'outgoing');
  assert.equal(values.relationStatus.backend, 'languageService'); assert.equal(values.length, 1);
  assert.deepEqual(s.calls, ['vscode.prepareCallHierarchy', 'vscode.provideOutgoingCalls']); s.engine.dispose();
});

test('building, excluded, unsupported, missing and actual empty call results stay distinct', async () => {
  const s = setup({ timeoutMs: 5, localTimeoutMs: 5 });
  s.env.settings.set('sourceInsightInspired.relationBackend', 'local');
  for (const state of ['building', 'excluded', 'notIndexed', 'ready']) {
    s.engine.invalidate(); s.local.describe = () => ({ state, note: state }); s.local.prepare = state === 'building' ? hang : async () => [];
    const values = await s.engine.prepare(s.doc.uri, s.range.start, 'root');
    assert.equal(values.relationStatus.state, state === 'ready' ? 'notFound' : state);
  }
  s.local.supports = () => false; s.engine.invalidate();
  const unsupported = await s.engine.prepare(s.doc.uri, s.range.start, 'root');
  assert.equal(unsupported.relationStatus.state, 'unsupported'); assert.equal(s.calls.length, 0);
  s.local.supports = () => true; s.local.describe = () => ({ state: 'ready', note: 'ready' }); s.local.prepare = async () => [s.localItem];
  s.engine.invalidate(); const empty = await s.engine.calls(s.localItem, 'outgoing'); assert.equal(empty.relationStatus.state, 'empty'); s.engine.dispose();
});

test('concurrent timeouts open a per-direction cooldown; invalidation preserves it and manual refresh resets it', async () => {
  let now = 1000;
  const s = setup({ timeoutMs: 5, now: () => now, cooldownMs: 30000 });
  s.env.settings.set('sourceInsightInspired.relationBackend', 'languageService');
  let requests = 0; s.engine.execute = () => { requests++; return hang(); };
  await Promise.all([s.engine.calls({ ...s.item, name: 'one' }, 'incoming'), s.engine.calls({ ...s.item, name: 'two' }, 'incoming')]);
  assert.equal(requests, 2);
  s.engine.invalidate();
  const paused = await s.engine.calls({ ...s.item, name: 'three' }, 'incoming');
  assert.equal(paused.relationStatus.state, 'cooldown'); assert.equal(requests, 2);
  await s.engine.calls(s.item, 'outgoing'); assert.equal(requests, 3);
  s.engine.invalidate(true); await s.engine.calls(s.item, 'incoming'); assert.equal(requests, 4);
  now += 40000; s.engine.invalidate(); await s.engine.calls(s.item, 'incoming'); assert.equal(requests, 5); s.engine.dispose();
});

test('requests coalesce and cache by index revision; short-lived empty results retry and late results cannot refill invalidated cache', async () => {
  let now = 1000, requests = 0, finish;
  const s = setup({ now: () => now });
  s.local.calls = async () => { requests++; return [{ to: s.item, fromRanges: [s.range] }]; };
  await Promise.all([s.engine.calls(s.localItem, 'outgoing'), s.engine.calls(s.localItem, 'outgoing')]); assert.equal(requests, 1);
  await s.engine.calls(s.localItem, 'outgoing'); assert.equal(requests, 1);
  s.local.revision++; await s.engine.calls(s.localItem, 'outgoing'); assert.equal(requests, 2);
  now += 31000; await s.engine.calls(s.localItem, 'outgoing'); assert.equal(requests, 3);
  s.engine.invalidate(); s.local.calls = async () => { requests++; return []; };
  await s.engine.calls(s.localItem, 'outgoing'); await s.engine.calls(s.localItem, 'outgoing'); assert.equal(requests, 4);
  now += 751; await s.engine.calls(s.localItem, 'outgoing'); assert.equal(requests, 5);
  s.engine.invalidate(); s.local.calls = () => new Promise(resolve => { finish = resolve; });
  const old = s.engine.calls(s.localItem, 'outgoing');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  s.engine.invalidate(); s.local.calls = async () => [{ to: { ...s.item, name: 'fresh' }, fromRanges: [] }];
  await s.engine.calls(s.localItem, 'outgoing'); finish([]); await old;
  assert.equal((await s.engine.calls(s.localItem, 'outgoing'))[0].to.name, 'fresh'); s.engine.dispose();
});

test('ambiguous same-name fallback never silently picks the first local or semantic function', async () => {
  const s = setup(); s.env.settings.set('sourceInsightInspired.relationBackend', 'local');
  s.local.prepare = async () => [1, 2].map(line => ({ ...s.localItem, selectionRange: new s.env.api.Range(line, 0, line, 4) }));
  const values = await s.engine.calls(s.item, 'incoming'); assert.equal(values.length, 0); assert.equal(values.relationStatus.state, 'ambiguous'); s.engine.dispose();
});

test('manual retry is not undone by late timeouts, and disposal cancels pending deadlines', async () => {
  const s = setup({ timeoutMs: 10 }); s.env.settings.set('sourceInsightInspired.relationBackend', 'languageService');
  let requests = 0;
  s.engine.execute = () => { requests++; return hang(); };
  const old = [s.engine.calls({ ...s.item, name: 'old-one' }, 'incoming'), s.engine.calls({ ...s.item, name: 'old-two' }, 'incoming')];
  await new Promise(resolve => setImmediate(resolve)); s.engine.invalidate(true); await Promise.all(old);
  s.engine.execute = async () => { requests++; return []; };
  const current = await s.engine.calls({ ...s.item, name: 'new' }, 'incoming');
  assert.equal(current.relationStatus.state, 'empty'); assert.equal(requests, 3);
  s.engine.invalidate(); s.engine.execute = hang;
  const pending = s.engine.calls(s.item, 'outgoing');
  await new Promise(resolve => setImmediate(resolve)); s.engine.dispose();
  assert.equal((await pending).relationStatus.state, 'cancelled');
});

test('empty language responses also recheck a newly ready local index', async () => {
  const s = setup(); let ready = false;
  s.local.prepare = async () => ready ? [s.localItem] : [];
  s.local.calls = async () => [{ to: s.item, fromRanges: [] }];
  s.engine.execute = async () => { ready = true; return []; };
  const roots = await s.engine.prepare(s.doc.uri, s.range.start, 'root');
  assert.equal(roots.relationStatus.backend, 'local'); assert.equal(roots.length, 1);
  ready = false; s.engine.invalidate();
  const calls = await s.engine.calls(s.item, 'outgoing');
  assert.equal(calls.relationStatus.backend, 'local'); assert.equal(calls.length, 1); s.engine.dispose();
});

test('local nodes from an earlier index generation are resolved again before querying edges', async () => {
  const s = setup(); s.local.summary = { generation: 2 };
  const old = { ...s.localItem, sourceInsightInspiredLocal: { id: 'old', generation: 1 } };
  const current = { ...s.localItem, sourceInsightInspiredLocal: { id: 'new', generation: 2 } };
  s.local.prepare = async () => [current];
  s.local.calls = async root => { assert.equal(root.sourceInsightInspiredLocal.id, 'new'); return []; };
  assert.equal((await s.engine.calls(old, 'incoming')).relationStatus.state, 'empty'); s.engine.dispose();
});
