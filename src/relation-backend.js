'use strict';
const vscode = require('vscode');
const { uriKey, sameUri, relativeUriPath } = require('./resources');

class RelationFailure extends Error {
  constructor(state, message) { super(message); this.state = state; }
}
const result = (values, backend, state, note, local) => Object.assign([...(values || [])], {
  relationStatus: { backend, state, note, local: local?.status || '', revision: local?.revision || 0 }
});

// One policy for root preparation and both edge directions. Provider items remain
// opaque: a local item is never passed to a language provider, or vice versa.
class RelationBackend {
  constructor(local, execute, options = {}) {
    this.local = local; this.execute = execute; this.options = options; this.now = options.now || Date.now;
    this.cache = new Map(); this.circuits = new Map(); this.epoch = 0; this.circuitEpoch = 0; this.aborts = new Set();
  }
  config(key, fallback) { return vscode.workspace.getConfiguration('sourceInsightInspired').get(key, fallback); }
  mode() { return this.config('relationBackend', 'auto'); }
  revision() { return `${this.epoch}:${this.local?.revision || 0}:${this.mode()}`; }
  invalidate(manual = false) { this.epoch++; this.cache.clear(); if (manual) { this.circuitEpoch++; this.circuits.clear(); } }
  describe(uri) {
    if (!this.local || !this.local.enabled()) return { state: 'disabled', note: '本地 C 索引未启用' };
    if (!this.local.supports(uri)) return { state: 'unsupported', note: '本地索引仅支持工作区内的 C / 头文件' };
    return this.local.describe?.(uri) || { state: 'notFound', note: this.local.status || '本地索引未找到该函数' };
  }
  bounded(operation, timeout, label) {
    let timer, cancel;
    const deadline = new Promise((resolve, reject) => {
      cancel = () => reject(new RelationFailure('cancelled', '查询已结束'));
      this.aborts.add(cancel);
      timer = setTimeout(() => reject(new RelationFailure('timeout', `${label}超时`)), timeout);
    });
    return Promise.race([Promise.resolve().then(operation), deadline]).finally(() => { clearTimeout(timer); this.aborts.delete(cancel); });
  }
  languageKey(command, uri) {
    const root = vscode.workspace.workspaceFolders?.find(folder => relativeUriPath(folder.uri, uri) !== undefined);
    const extension = /\.(c|h)$/i.test(uri.path) ? 'c' : uri.path.split('.').pop().toLowerCase();
    return `${root ? uriKey(root.uri) : uri.scheme}:${extension}:${command}`;
  }
  async language(command, uri, ...args) {
    if (this.disposed) throw new RelationFailure('cancelled', '查询已结束');
    const key = this.languageKey(command, uri), circuit = this.circuits.get(key) || { failures: 0, until: 0 };
    const circuitEpoch = this.circuitEpoch;
    this.circuits.set(key, circuit);
    if (this.now() < circuit.until) throw new RelationFailure('cooldown', `语言服务连续超时，暂停自动重试 ${Math.ceil((circuit.until - this.now()) / 1000)} 秒；手动刷新可重试`);
    try {
      const values = await this.bounded(() => this.execute(command, ...args), this.options.timeoutMs ?? this.config('relationTimeoutMs', 5000), '语言服务调用关系查询');
      if (this.circuits.get(key) === circuit && this.circuitEpoch === circuitEpoch) this.circuits.delete(key); return values || [];
    } catch (error) {
      if (!this.disposed) this.local?.log?.(`[Relation] ${command}: ${error.message}`);
      if (!this.disposed && this.circuitEpoch === circuitEpoch && error.state === 'timeout') {
        circuit.failures++;
        if (circuit.failures >= 2) circuit.until = this.now() + (this.options.cooldownMs ?? this.config('relationRetryDelayMs', 30000));
        this.circuits.set(key, circuit);
      }
      throw error;
    }
  }
  cached(key, operation) {
    if (this.disposed) return Promise.resolve(result([], 'none', 'cancelled', '查询已结束', this.local));
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.promise;
    const entry = { expires: Infinity, promise: undefined };
    entry.promise = Promise.resolve().then(() => operation()).then(values => {
      if (this.cache.get(key) === entry) entry.expires = this.now() + (values.length ? 30000 : 750);
      return values;
    }, error => { if (this.cache.get(key) === entry) this.cache.delete(key); throw error; });
    this.cache.set(key, entry);
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
    return entry.promise;
  }
  async localRoots(uri, position, name) {
    if (!this.local?.enabled() || !this.local.supports(uri) || this.describe(uri).state === 'excluded') return [];
    return this.bounded(() => this.local.prepare(uri, position, name), this.options.localTimeoutMs ?? this.config('relationLocalTimeoutMs', 2000), '本地 C 索引查询');
  }
  localNote(uri, error) {
    const status = this.describe(uri);
    if (error) return { state: status.state === 'building' ? 'building' : error.state || 'error', note: `${status.note}；${error.message}` };
    return { state: status.state === 'ready' ? 'notFound' : status.state, note: status.state === 'ready' ? '本地 C 索引未找到该函数（可能未收录或为宏 / 间接调用）' : status.note };
  }
  prepare(uri, position, name) {
    const key = `prepare:${this.revision()}:${uriKey(uri)}:${position.line}:${position.character}:${name || ''}`;
    return this.cached(key, async () => {
      let localError;
      if (this.mode() !== 'languageService') {
        try {
          const roots = await this.localRoots(uri, position, name);
          if (roots.length) return result(roots, 'local', 'ready', '本地 C 索引', this.local);
        } catch (error) { localError = error; }
        if (this.mode() === 'local') {
          const status = this.localNote(uri, localError); return result([], 'local', status.state, status.note, this.local);
        }
      }
      try {
        const roots = await this.language('vscode.prepareCallHierarchy', uri, uri, position);
        if (roots.length) return result(roots, 'languageService', 'ready', `语言服务${this.mode() === 'auto' ? `；${this.localNote(uri, localError).note}` : ''}`, this.local);
        if (this.mode() === 'auto' && this.describe(uri).state !== 'building') {
          try {
            const fallback = await this.localRoots(uri, position, name);
            if (fallback.length) return result(fallback, 'local', 'ready', '已回退本地 C 索引；语言服务未返回函数', this.local);
          } catch (error) { localError = error; }
        }
        const note = this.mode() === 'auto' ? this.localNote(uri, localError) : { state: 'notFound', note: '语言服务未返回函数；可能未就绪、不支持或当前位置不是函数' };
        return result([], 'languageService', note.state, note.note, this.local);
      } catch (error) {
        // The index may have finished while the language server was timing out.
        if (this.mode() === 'auto' && this.describe(uri).state !== 'building') {
          try {
            const roots = await this.localRoots(uri, position, name);
            if (roots.length) return result(roots, 'local', 'ready', `已回退本地 C 索引；${error.message}`, this.local);
          } catch (failure) { localError = failure; }
        }
        const note = this.mode() === 'auto' ? this.localNote(uri, localError) : undefined;
        return result([], 'none', note?.state === 'building' ? 'building' : error.state || 'error',
          `${note ? note.note + '；' : ''}${error.message}`, this.local);
      }
    });
  }
  unique(roots, item) {
    const named = roots.filter(root => root.name === item.name);
    if (named.length === 1) return named[0];
    const exact = named.filter(root => sameUri(root.uri, item.uri) && root.selectionRange.start.line === item.selectionRange.start.line &&
      root.selectionRange.start.character === item.selectionRange.start.character);
    if (exact.length === 1) return exact[0];
    if (roots.length) throw new RelationFailure('ambiguous', '存在多个同名函数，未自动选择调用根节点');
  }
  async localCalls(item, direction) {
    const current = item.sourceInsightInspiredLocal && (!this.local.summary || item.sourceInsightInspiredLocal.generation === this.local.summary.generation);
    const roots = current ? [item] : await this.localRoots(item.uri, item.selectionRange.start, item.name);
    const root = this.unique(roots, item); if (!root) return undefined;
    const calls = await this.bounded(() => this.local.calls(root, direction), this.options.localTimeoutMs ?? this.config('relationLocalTimeoutMs', 2000), '本地 C 调用关系查询');
    return result(calls, 'local', calls.length ? 'ready' : 'empty', calls.length ? '本地 C 索引' :
      direction === 'incoming' ? '本地索引未找到直接调用者；宏展开、间接调用或索引范围外的使用可能未收录' : '本地索引未找到直接调用；函数指针等间接调用不在此列表中', this.local);
  }
  calls(item, direction) {
    const key = `calls:${this.revision()}:${direction}:${uriKey(item.uri)}:${item.selectionRange.start.line}:${item.selectionRange.start.character}:${item.name}:${JSON.stringify(item.sourceInsightInspiredLocal || null)}`;
    return this.cached(key, async () => {
      let localError;
      if (this.mode() !== 'languageService' && this.local?.enabled() && this.local.supports(item.uri)) {
        try { const calls = await this.localCalls(item, direction); if (calls) return calls; } catch (error) { localError = error; }
      }
      if (this.mode() === 'local') {
        const note = this.localNote(item.uri, localError); return result([], 'local', note.state, note.note, this.local);
      }
      try {
        // Local hierarchy data cannot be interpreted by clangd. Re-prepare a
        // semantic root before fallback, without guessing among overloads.
        let semantic = item;
        if (item.sourceInsightInspiredLocal) semantic = this.unique(await this.language('vscode.prepareCallHierarchy', item.uri, item.uri, item.selectionRange.start), item);
        if (!semantic) throw new RelationFailure('notFound', '语言服务未找到对应函数');
        const command = direction === 'incoming' ? 'vscode.provideIncomingCalls' : 'vscode.provideOutgoingCalls';
        const calls = await this.language(command, item.uri, semantic);
        if (!calls.length && this.mode() === 'auto' && this.local?.enabled() && this.local.supports(item.uri) && this.describe(item.uri).state !== 'building') {
          try {
            const fallback = await this.localCalls(item, direction);
            if (fallback) { fallback.relationStatus.note = `已回退本地 C 索引；语言服务未返回调用；${fallback.relationStatus.note}`; return fallback; }
          } catch (error) { localError = error; }
        }
        return result(calls, 'languageService', calls.length ? 'ready' : 'empty', calls.length ? '语言服务' : '语言服务未返回调用；可能无直接调用、未就绪或不支持', this.local);
      } catch (error) {
        if (this.mode() === 'auto' && this.local?.enabled() && this.local.supports(item.uri) && this.describe(item.uri).state !== 'building') {
          try { const calls = await this.localCalls(item, direction); if (calls) {
            calls.relationStatus.note = `已回退本地 C 索引；${error.message}；${calls.relationStatus.note}`; return calls;
          } } catch (failure) { localError = failure; }
        }
        const localNote = this.mode() === 'auto' ? this.localNote(item.uri, localError) : undefined;
        return result([], 'none', localNote?.state === 'building' ? 'building' : error.state || 'error',
          `${localNote ? localNote.note + '；' : ''}${error.message}`, this.local);
      }
    });
  }
  dispose() { this.disposed = true; this.invalidate(); for (const cancel of this.aborts) cancel(); this.aborts.clear(); }
}
module.exports = { RelationBackend };
