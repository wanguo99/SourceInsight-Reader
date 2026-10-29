'use strict';
const { queryResult } = require('./domain/model');
const { isUsageKind } = require('./domain/relation-kind');
class RelationBackend {
  constructor({ local, semantic, settings, scope, configuration = () => '', log = message => {}, now = Date.now }) {
    this.local = local; this.semantic = semantic; this.settings = settings; this.scope = scope; this.configuration = configuration; this.log = log; this.now = now;
    this.cache = new Map(); this.circuits = new Map(); this.aborts = new Set(); this.epoch = 0; this.circuitEpoch = 0;
  }
  revision() { return `${this.epoch}:${this.local.revision()}:${this.settings('relationBackend', 'auto')}:${this.configuration()}`; }
  invalidate(manual = false) {
    this.epoch++; this.cache.clear(); this.local.invalidate(); this.semantic.invalidate();
    if (manual) { this.circuitEpoch++; this.circuits.clear(); }
  }
  async request(provider, operation, source, direction) {
    const key = `${this.scope(source.uri)}:${operation}:${direction || ''}`;
    const circuit = this.circuits.get(key) || { failures: 0, until: 0 }, epoch = this.circuitEpoch;
    const error = (status, note) => queryResult([], provider.id, status, this.revision(), [note]);
    if (this.disposed) return error('cancelled', '查询已结束');
    if (provider.id === 'languageService') {
      if (circuit.until > this.now()) return error('cooldown', '语言服务连续超时，暂停自动查询；手动刷新可立即重试');
      this.circuits.set(key, circuit);
    }
    let timer, cancel;
    try {
      const timeout = provider.id === 'local' ? this.settings('relationLocalTimeoutMs', 2000) : this.settings('relationTimeoutMs', 5000);
      const result = await Promise.race([
        Promise.resolve().then(() => operation === 'prepare' ? provider.prepare(source) : provider.calls(source.symbol, direction)),
        new Promise(resolve => {
          cancel = () => resolve(error('cancelled', '查询已结束')); this.aborts.add(cancel);
          timer = setTimeout(() => resolve(error('timeout', `${provider.id === 'local' ? '本地 C 索引' : '语言服务'}查询超时`)), timeout);
        })
      ]);
      if (provider.id === 'languageService' && epoch === this.circuitEpoch && this.circuits.get(key) === circuit && !this.disposed) {
        if (result.status === 'timeout') {
          circuit.failures++; if (circuit.failures >= 2) circuit.until = this.now() + this.settings('relationRetryDelayMs', 30000);
        } else if (['ready', 'empty'].includes(result.status)) this.circuits.delete(key);
      }
      return result;
    } catch (failure) {
      const note = typeof failure === 'string' ? failure : typeof failure?.message === 'string' ? failure.message
        : provider.id === 'languageService' ? '语言服务请求失败，未返回错误详情；请查看 clangd 或对应语言扩展的输出日志' : '本地索引请求失败，未返回错误详情；请查看插件日志';
      this.log(`Relation ${provider.id}: ${note}`);
      return error(['timeout', 'cancelled'].includes(failure?.code) ? failure.code : 'error', note);
    }
    finally { clearTimeout(timer); this.aborts.delete(cancel); }
  }
  query(operation, source, direction) {
    const mode = this.settings('relationBackend', 'auto');
    const key = `${this.revision()}:${operation}:${source.symbol?.id || JSON.stringify(source)}:${direction || ''}`;
    const cached = this.cache.get(key); if (cached && cached.expires > this.now()) return cached.promise;
    const entry = { expires: Infinity, promise: undefined };
    entry.promise = (async () => {
      if (mode === 'auto') {
        const usage = operation === 'calls' && isUsageKind(source.symbol?.kind);
        let indexed;
        const callbackIncoming = operation === 'calls' && direction === 'incoming';
        if ((operation === 'prepare' || usage || callbackIncoming) && this.local.supports(source.uri)) {
          const local = indexed = await this.request(this.local, operation, source, direction);
          if (usage && ['ready', 'empty', 'building'].includes(local.status) || local.data.some(value => isUsageKind(value.kind)) ||
            callbackIncoming && local.data.some(edge => edge.symbol.kind === 7)) return local;
        }
        const semantic = await this.request(this.semantic, operation, source, direction);
        if (semantic.data.length) return semantic;
        if (this.local.supports(source.uri)) {
          const fallback = indexed || await this.request(this.local, operation, source, direction);
          if (semantic.status === 'empty' && !fallback.data.length && !['ready', 'empty', 'building'].includes(fallback.status)) return semantic;
          return queryResult(fallback.data, 'local', fallback.status, this.revision(), [...fallback.diagnostics, ...semantic.diagnostics]);
        }
        return semantic;
      }
      let localResult;
      if (mode !== 'languageService' && this.local.supports(source.uri)) {
        localResult = await this.request(this.local, operation, source, direction);
        if (['ready', 'empty'].includes(localResult.status)) return localResult;
      }
      if (mode === 'local') return localResult || queryResult([], 'local', 'unsupported', this.revision(), [this.local.describe(source.uri).note]);
      const semantic = await this.request(this.semantic, operation, source, direction);
      if (semantic.data.length) return semantic;
      if (mode === 'auto' && this.local.supports(source.uri) && this.local.describe(source.uri).state !== 'building') {
        const fallback = await this.request(this.local, operation, source, direction);
        if (['ready', 'empty'].includes(fallback.status)) return queryResult(fallback.data, 'local', fallback.status, this.revision(), [...fallback.diagnostics, ...semantic.diagnostics]);
        localResult = fallback;
      }
      return queryResult(semantic.data, semantic.provider, localResult?.status === 'building' ? 'building' : semantic.status,
        this.revision(), [...(localResult?.diagnostics || []), ...semantic.diagnostics]);
    })().then(value => { if (this.cache.get(key) === entry) entry.expires = this.now() + (value.data.length ? 30000 : 750); return value; });
    this.cache.set(key, entry); if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value); return entry.promise;
  }
  beginVerification() { this.semantic.invalidate(); this.circuitEpoch++; this.circuits.clear(); }
  verifyCalls(symbol, direction) {
    // An explicit verification retries the semantic provider without replacing
    // the configured automatic backend or mixing two different compilations.
    this.circuitEpoch++; this.circuits.clear();
    return this.request(this.semantic, 'calls', { ...symbol.location, symbol }, direction);
  }
  prepare(source) { return this.query('prepare', source); }
  calls(symbol, direction) { return this.query('calls', { ...symbol.location, symbol }, direction); }
  dispose() { this.disposed = true; this.invalidate(); for (const cancel of this.aborts) cancel(); this.aborts.clear(); this.local.dispose?.(); this.semantic.dispose?.(); }
}
module.exports = { RelationBackend };
