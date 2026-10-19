'use strict';
const vscode = require('vscode');
const { location, symbol, queryResult } = require('../domain/model');
const { sameUri } = require('../resources');
class RelationProvider {
  constructor(id) { this.id = id; this.handles = new Map(); this.epoch = 0; }
  invalidate() { this.epoch++; this.handles.clear(); }
  revision() { return String(this.epoch); }
  remember(raw) {
    const value = symbol(raw, Boolean(raw.sourceInsightInspiredLocal?.unresolved));
    this.handles.set(value.id, { raw, revision: this.revision() });
    if (this.handles.size > 2048) this.handles.delete(this.handles.keys().next().value);
    return value;
  }
  choose(values, target) {
    const exact = values.find(value => value.id === target.id); if (exact) return exact;
    const named = values.filter(value => value.name === target.name && sameUri(value.location.uri, target.location.uri));
    return named.length === 1 ? named[0] : undefined;
  }
  result(data, status, ...diagnostics) { return queryResult(data, this.id, status, this.revision(), diagnostics); }
}
class LocalCProvider extends RelationProvider {
  constructor(index) { super('local'); this.index = index; }
  revision() { return `${this.epoch}:${this.index?.revision || 0}`; }
  supports(uri) { return Boolean(this.index?.enabled()) && this.index.supports(vscode.Uri.parse(uri)); }
  describe(uri) { return this.index?.describe(vscode.Uri.parse(uri)) || { state: 'unsupported', note: '本地索引未启用' }; }
  async prepare(source) {
    if (!this.supports(source.uri)) return this.result([], 'unsupported', '本地 C 索引未启用或不支持当前文件');
    const before = this.describe(source.uri); if (before.state === 'excluded') return this.result([], 'excluded', before.note);
    const raw = await this.index.prepare(vscode.Uri.parse(source.uri), source.range.start, source.name);
    const state = this.describe(source.uri);
    return raw.length ? this.result(raw.map(item => this.remember(item)), 'ready', '本地 C 索引')
      : this.result([], state.state === 'ready' ? 'notFound' : state.state, state.note);
  }
  async calls(target, direction) {
    let handle = this.handles.get(target.id);
    if (!handle || handle.revision !== this.revision()) {
      const roots = await this.prepare({ ...target.location, name: target.name });
      const current = this.choose(roots.data, target);
      if (!current) return this.result([], roots.data.length ? 'ambiguous' : roots.status, ...roots.diagnostics);
      handle = this.handles.get(current.id);
    }
    const calls = await this.index.calls(handle.raw, direction);
    const data = calls.map(call => ({ symbol: this.remember(direction === 'incoming' ? call.from : call.to),
      sites: call.fromRanges.map(value => location({ uri: direction === 'incoming' ? call.from.uri : handle.raw.uri, range: value })) }));
    return this.result(data, data.length ? 'ready' : 'empty', data.length ? '本地 C 索引' :
      '本地索引未找到直接调用；宏展开、函数指针或索引范围外使用可能未收录');
  }
}
class LanguageServiceProvider extends RelationProvider {
  constructor() { super('languageService'); }
  supports() { return true; }
  describe() { return { state: 'ready', note: '语言服务' }; }
  async prepare(source) {
    /** @type {any[]} */
    const values = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', vscode.Uri.parse(source.uri), new vscode.Position(source.range.start.line, source.range.start.character));
    return this.result((values || []).map(item => this.remember(item)), values === undefined ? 'unsupported' : values.length ? 'ready' : 'notFound', '语言服务函数查询');
  }
  async calls(target, direction) {
    let handle = this.handles.get(target.id);
    if (!handle) {
      const roots = await this.prepare({ ...target.location, name: target.name });
      const current = this.choose(roots.data, target);
      if (!current) return this.result([], roots.data.length ? 'ambiguous' : roots.status, '语言服务无法唯一确定函数');
      handle = this.handles.get(current.id);
    }
    /** @type {any[]} */
    const values = await vscode.commands.executeCommand(direction === 'incoming' ? 'vscode.provideIncomingCalls' : 'vscode.provideOutgoingCalls', handle.raw);
    const data = (values || []).map(call => ({ symbol: this.remember(direction === 'incoming' ? call.from : call.to),
      sites: call.fromRanges.map(value => location({ uri: direction === 'incoming' ? call.from.uri : handle.raw.uri, range: value })) }));
    return this.result(data, values === undefined ? 'unsupported' : data.length ? 'ready' : 'empty', data.length ? '语言服务' : '语言服务未返回直接调用，可能未就绪或无结果');
  }
}
module.exports = { LocalCProvider, LanguageServiceProvider };
