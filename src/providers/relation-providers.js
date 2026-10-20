'use strict';
const vscode = require('vscode');
const { location, symbol, queryResult } = require('../domain/model');
const { sameUri } = require('../resources');
class RelationProvider {
  constructor(id) { this.id = id; this.handles = new Map(); this.epoch = 0; }
  invalidate() { this.epoch++; this.handles.clear(); }
  revision() { return String(this.epoch); }
  remember(raw) {
    const value = symbol(raw, Boolean(raw.sourceInsightReaderLocal?.unresolved));
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
    if (['error', 'excluded', 'notIndexed'].includes(state.state)) return this.result([], state.state, state.note);
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
    const notes = this.index.callDiagnostics ? await this.index.callDiagnostics(handle.raw, direction) : ['本地 C 语法索引：仅直接调用，宏展开、函数指针可能未收录'];
    if (!data.length) notes.unshift('本地索引未找到直接调用');
    if (this.index.summary?.failures?.length) notes.push(`${this.index.summary.failures.length} 个文件索引失败，工程调用关系可能不完整`);
    return this.result(data, data.length ? 'ready' : 'empty', ...notes);
  }
}
class LanguageServiceProvider extends RelationProvider {
  constructor(catalog) { super('languageService'); this.catalog = catalog; }
  supports(uri) { return !this.catalog || this.catalog.accepts(vscode.Uri.parse(uri.toString())); }
  describe() { return { state: 'ready', note: '语言服务' }; }
  async prepare(source) {
    if (!this.supports(source.uri)) return this.result([], 'excluded', '当前文件已被屏蔽或不在工作区内');
    /** @type {any[]} */
    const values = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', vscode.Uri.parse(source.uri), new vscode.Position(source.range.start.line, source.range.start.character));
    return this.result((values || []).filter(item => this.supports(item.uri)).map(item => this.remember(item)), values === undefined ? 'unsupported' : values.length ? 'ready' : 'notFound', '语言服务函数查询');
  }
  async calls(target, direction) {
    if (!this.supports(target.location.uri)) return this.result([], 'excluded', '当前函数已被屏蔽或不在工作区内');
    let handle = this.handles.get(target.id);
    if (!handle) {
      const roots = await this.prepare({ ...target.location, name: target.name });
      const current = this.choose(roots.data, target);
      if (!current) return this.result([], roots.data.length ? 'ambiguous' : roots.status, '语言服务无法唯一确定函数');
      handle = this.handles.get(current.id);
    }
    /** @type {any[]} */
    const values = await vscode.commands.executeCommand(direction === 'incoming' ? 'vscode.provideIncomingCalls' : 'vscode.provideOutgoingCalls', handle.raw);
    const data = (values || []).filter(call => this.supports(direction === 'incoming' ? call.from.uri : call.to.uri)).map(call => ({ symbol: this.remember(direction === 'incoming' ? call.from : call.to),
      sites: call.fromRanges.map(value => location({ uri: direction === 'incoming' ? call.from.uri : handle.raw.uri, range: value })) }));
    return this.result(data, values === undefined ? 'unsupported' : data.length ? 'ready' : 'empty', data.length ? '语言服务' : '语言服务未返回直接调用，可能未就绪或无结果');
  }
}
module.exports = { LocalCProvider, LanguageServiceProvider };
