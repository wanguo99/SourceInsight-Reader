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
