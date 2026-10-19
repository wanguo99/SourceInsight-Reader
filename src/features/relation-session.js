'use strict';
const { Observable } = require('../domain/observable');
const state = require('../domain/query-state');
const { location, queryResult } = require('../domain/model');
class RelationSession {
  constructor(engine, choose = async values => values[0]) {
    this.engine = engine; this.choose = choose; this.events = new Observable(); this.onDidChange = listener => this.events.subscribe(listener);
    this.rootState = state.idle(); this.edges = new Map(); this.pending = new Map(); this.sequence = 0; this.edgeSequence = 0; this.expires = new Map();
    this.graphMode = true; this.direction = 'incoming'; this.locked = false; this.disposed = false;
  }
  get root() { return this.rootState.data[0]; }
  key(symbol, direction) { return `${symbol.id}:${direction}`; }
  edgeState(symbol, direction) { return this.edges.get(this.key(symbol, direction)) || state.idle(); }
  publish() { this.events.emit(this.snapshot()); }
  snapshot() { return { root: this.rootState, direction: this.direction, locked: this.locked }; }
  async setRoot(source, { manual = false, interactive = false } = {}) {
    const normalized = { ...location(source), name: source.name };
    const key = JSON.stringify(normalized);
    if (this.locked && (!manual || this.sourceKey !== key)) return;
    const id = ++this.sequence; const previous = this.sourceKey === key ? this.rootState : state.idle();
    this.source = normalized; this.sourceKey = key;
    this.rootState = state.begin(previous, id, this.engine.revision()); this.publish();
    let result;
    try {
      result = await this.engine.prepare(normalized);
      if (this.disposed || id !== this.sequence) return;
      if (result.data.length > 1) {
        const selected = interactive ? await this.choose(result.data) : undefined;
        if (this.disposed || id !== this.sequence) return;
        result = selected ? queryResult([selected], result.provider, 'ready', result.revision, result.diagnostics)
          : queryResult([], result.provider, 'ambiguous', result.revision, ['存在多个函数候选，请使用“设为根”选择']);
      }
    } catch (error) { result = queryResult([], 'none', 'error', this.engine.revision(), [error.message]); }
    if (this.disposed || id !== this.sequence) return;
    this.rootState = state.settle(this.rootState, result); this.publish();
  }
  switchDirection(direction) { this.direction = direction; this.publish(); }
  toggleLock() { this.locked = !this.locked; this.sequence++;
    if (['loading', 'refreshing'].includes(this.rootState.status)) this.rootState = state.settle(this.rootState, queryResult([], 'none', 'cancelled', this.engine.revision(), ['跟随查询已取消']));
    this.publish(); }
  invalidate() {
    this.sequence++; this.rootState = state.stale(this.rootState, this.sequence);
    for (const [key, value] of this.edges) this.edges.set(key, state.stale(value, this.sequence));
    this.publish();
  }
  async load(symbol, direction) {
    if (this.disposed || this.rootState.status === 'stale') return this.edgeState(symbol, direction);
    const key = this.key(symbol, direction), revision = this.engine.revision(), requestKey = `${revision}:${key}`;
    if (this.pending.has(requestKey)) return this.pending.get(requestKey);
    const previous = this.edgeState(symbol, direction);
    if ((this.expires.get(key) || 0) > Date.now() && previous.revision === revision && ['ready', 'empty', 'retained', 'failed'].includes(previous.status)) return previous;
    const loading = state.begin(previous, ++this.edgeSequence, revision);
    this.edges.set(key, loading);
    const pending = Promise.resolve().then(() => this.engine.calls(symbol, direction)).catch(error => queryResult([], 'none', 'error', revision, [error.message])).then(result => {
      if (this.disposed || this.engine.revision() !== revision || this.edges.get(key) !== loading) return this.edgeState(symbol, direction);
      const next = Object.freeze({ ...state.settle(loading, result), revision });
      this.expires.set(key, Date.now() + (result.data.length ? 30000 : 750));
      this.edges.set(key, next); if (this.edges.size > 256) { const first = this.edges.keys().next().value; this.edges.delete(first); this.expires.delete(first); }
      this.publish(); return next;
    }).finally(() => this.pending.delete(requestKey));
    this.pending.set(requestKey, pending); this.publish(); return pending;
  }
  async ensureRootEdges() {
    if (!this.root || !['ready', 'empty'].includes(this.rootState.status)) return;
    await Promise.all((this.graphMode === false ? [this.direction] : ['incoming', 'outgoing']).map(direction => this.load(this.root, direction)));
  }
  async whenIdle() { while (this.pending.size) await Promise.all([...this.pending.values()]); }
  async refresh() { if (this.source) { this.engine.invalidate(true); await this.setRoot(this.source, { manual: true, interactive: true }); } }
  dispose() { this.disposed = true; this.sequence++; this.events.dispose(); this.pending.clear(); }
}
module.exports = { RelationSession };
