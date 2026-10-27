'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RelationBackend } = require('../src/relation-backend');
const { queryResult, symbol } = require('../src/domain/model');
const target = symbol({ name: 'root', uri: 'file:///project/a.c', selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 8 } } });
const source = { ...target.location, name: target.name };
const hang = () => new Promise(() => {});
function setup(settings = {}) {
  let clock = 0;
  const provider = id => ({ id, epoch: 0, revision() { return String(this.epoch); }, invalidate() { this.epoch++; }, supports: () => true,
    describe: () => ({ state: 'ready', note: 'ready' }), prepare: async () => queryResult([target], id, 'ready'), calls: async () => queryResult([], id, 'empty') });
  const local = provider('local'), semantic = provider('languageService');
  semantic.prepare = async () => queryResult([], 'languageService', 'unsupported');
  semantic.calls = async () => queryResult([], 'languageService', 'unsupported');
  const engine = new RelationBackend({ local, semantic, scope: () => 'workspace:c', settings: (name, fallback) => settings[name] ?? fallback, now: () => clock });
  return { engine, local, semantic, advance: ms => { clock += ms; } };
}
test('local results have explicit metadata, coalesce and expire by revision', async t => {
  const s = setup(); t.after(() => s.engine.dispose()); let calls = 0;
  s.local.prepare = async () => { calls++; return queryResult([target], 'local', 'ready'); };
  const [a, b] = await Promise.all([s.engine.prepare(source), s.engine.prepare(source)]);
  assert.equal(a, b); assert.equal(calls, 1); assert.equal(a.provider, 'local'); assert.equal(a.data[0], target);
  s.engine.invalidate(); await s.engine.prepare(source); assert.equal(calls, 2);
  s.advance(30001); await s.engine.prepare(source); assert.equal(calls, 3);
});
test('local errors fall back to semantic calls without leaking raw provider handles', async t => {
  const s = setup(); t.after(() => s.engine.dispose());
  s.local.calls = async () => { throw new Error('worker unavailable'); };
  s.semantic.calls = async (value, direction) => { assert.equal(value, target); assert.equal(direction, 'outgoing'); return queryResult([{ symbol: target, sites: [] }], 'languageService', 'ready'); };
  assert.equal((await s.engine.calls(target, 'outgoing')).provider, 'languageService');
});
test('building, excluded, unsupported, missing and confirmed empty results remain distinct', async t => {
  const s = setup({ relationBackend: 'local' }); t.after(() => s.engine.dispose());
  for (const status of ['building', 'excluded', 'notIndexed', 'notFound', 'empty']) {
    s.engine.invalidate(); s.local.prepare = async () => queryResult([], 'local', status);
    assert.equal((await s.engine.prepare(source)).status, status);
  }
  s.local.supports = () => false; s.engine.invalidate(); assert.equal((await s.engine.prepare(source)).status, 'unsupported');
});
test('each direction times out independently and retries a newly ready local index', async t => {
  for (const direction of ['incoming', 'outgoing']) {
    const s = setup({ relationTimeoutMs: 5 }); t.after(() => s.engine.dispose()); let ready = false;
    s.local.calls = async () => queryResult(ready ? [{ symbol: target, sites: [] }] : [], 'local', ready ? 'ready' : 'notFound');
    s.semantic.calls = () => { ready = true; return hang(); };
    const result = await s.engine.calls(target, direction); assert.equal(result.provider, 'local'); assert.match(result.diagnostics.join(' '), /超时/);
  }
});
test('native timeouts open per-direction cooldown, normal invalidation preserves it, manual retry resets it', async t => {
  const s = setup({ relationBackend: 'languageService', relationTimeoutMs: 5 }); t.after(() => s.engine.dispose());
  s.semantic.calls = hang;
  for (let i = 0; i < 2; i++) { s.engine.invalidate(); assert.equal((await s.engine.calls(target, 'incoming')).status, 'timeout'); }
  s.engine.invalidate(); assert.equal((await s.engine.calls(target, 'incoming')).status, 'cooldown');
  assert.equal((await s.engine.calls(target, 'outgoing')).status, 'timeout');
  s.engine.invalidate(true); assert.equal((await s.engine.calls(target, 'incoming')).status, 'timeout');
});
test('empty results expire quickly; obsolete completions cannot repopulate invalidated cache', async t => {
  const s = setup(); t.after(() => s.engine.dispose()); let calls = 0, resolve;
  s.local.calls = async () => { calls++; return queryResult([], 'local', 'empty'); };
  await s.engine.calls(target, 'incoming'); await s.engine.calls(target, 'incoming'); assert.equal(calls, 1);
  s.advance(751); await s.engine.calls(target, 'incoming'); assert.equal(calls, 2);
  s.engine.invalidate(); s.local.prepare = () => new Promise(done => { resolve = done; });
  const pending = s.engine.prepare(source); await new Promise(done => setImmediate(done)); s.engine.invalidate();
  resolve(queryResult([target], 'local', 'ready')); await pending; assert.equal(s.engine.cache.size, 0);
});
test('disposal cancels pending deadlines and manual retry is not undone by late timeouts', async () => {
  const s = setup({ relationBackend: 'languageService', relationTimeoutMs: 10 }); s.semantic.prepare = hang;
  const pending = s.engine.prepare(source); await new Promise(done => setImmediate(done)); s.engine.dispose();
  assert.equal((await pending).status, 'cancelled'); assert.equal(s.engine.aborts.size, 0);
  const other = setup({ relationBackend: 'languageService', relationTimeoutMs: 5 }); other.semantic.calls = hang;
  const old = other.engine.calls(target, 'incoming'); await new Promise(done => setImmediate(done)); other.engine.invalidate(true); await old;
  assert.equal(other.engine.circuits.size, 0); other.engine.dispose();
});

test('explicit semantic verification bypasses local policy and retries after cooldown', async t => {
  const s = setup({ relationBackend: 'local', relationTimeoutMs: 5 }); t.after(() => s.engine.dispose());
  s.semantic.calls = hang;
  for (let i = 0; i < 2; i++) assert.equal((await s.engine.verifyCalls(target, 'incoming')).status, 'timeout');
  let queries = 0;
  s.semantic.calls = async () => { queries++; return queryResult([{ symbol: target, sites: [] }], 'languageService', 'ready'); };
  s.engine.beginVerification();
  const result = await s.engine.verifyCalls(target, 'incoming'); assert.equal(result.provider, 'languageService'); assert.equal(queries, 1);
  assert.equal((await s.engine.calls(target, 'incoming')).provider, 'local');
});
test('verification failure retains local edges, late completion cannot restore a cleared root', async t => {
  const { RelationSession } = require('../src/features/relation-session');
  const s = setup(); const session = new RelationSession(s.engine); t.after(() => { session.dispose(); s.engine.dispose(); });
  s.local.calls = async () => queryResult([{ symbol: target, sites: [] }], 'local', 'ready');
  await session.setRoot(source); await session.ensureRootEdges();
  s.semantic.calls = async () => queryResult([], 'languageService', 'unsupported', '', ['no provider']);
  await session.verify();
  assert.equal(session.edgeState(target, 'incoming').status, 'retained'); assert.equal(session.edgeState(target, 'incoming').data.length, 1);
  let finish;
  s.semantic.calls = () => new Promise(resolve => { finish = resolve; });
  const pending = session.verify();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  session.clear(); finish(queryResult([{ symbol: target, sites: [] }], 'languageService', 'ready'));
  // Resolve both directions independently; each sees the same deferred completion.
  s.engine.dispose(); await pending;
  assert.equal(session.root, undefined); assert.equal(session.edges.size, 0);
});

test('language providers rejecting with token objects or strings produce actionable diagnostics instead of undefined', async t => {
  const s = setup({ relationBackend: 'languageService' }); t.after(() => s.engine.dispose());
  s.semantic.prepare = async () => { throw { _isCancelled: false }; };
  let result = await s.engine.prepare(source);
  assert.equal(result.status, 'error'); assert.match(result.diagnostics[0], /语言服务请求失败.*输出日志/);
  s.engine.invalidate(); s.semantic.prepare = async () => { throw 'invalid AST'; };
  result = await s.engine.prepare(source);
  assert.equal(result.diagnostics[0], 'invalid AST');
});
