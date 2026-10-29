'use strict';
const path = require('node:path');
const { uriKey } = require('../resources');
const { isUsageKind } = require('../domain/relation-kind');
const at = (a, b) => a.line === b.line && a.character === b.character;
const identity = node => `${uriKey(node.uri)}#symbol:${node.selectionRange.start.line}:${node.selectionRange.start.character}:${node.kind}`;
const inside = (range, point) => {
  const compare = (a, b) => a.line - b.line || a.character - b.character;
  return compare(range.start, point) <= 0 && compare(point, range.end) < 0;
};
class SymbolRelations {
  constructor(index) { this.index = index; this.generation = -1; this.nodes = new Map(); this.cache = new Map(); this.limited = new Set(); this.candidates = new Set(); }
  reset() {
    if (this.generation === this.index.generation) return;
    this.generation = this.index.generation; this.nodes.clear(); this.cache.clear(); this.limited.clear(); this.candidates.clear();
  }
  supports(node) { return isUsageKind(node?.kind) && node.kind !== 7 && !['macroParameter', 'label'].includes(node.category); }
  register(node) {
    this.reset(); const value = { ...node, id: identity(node) }; this.nodes.set(value.id, value);
    if (this.nodes.size > 2048) this.nodes.delete(this.nodes.keys().next().value);
    return value;
  }
  item(node) {
    const value = this.register(node);
    return { name: value.name, uri: value.uri, kind: value.kind, range: value.range, selectionRange: value.selectionRange,
      detail: value.relationCandidate ? '候选宏定义 · 工程内包含链不完整，当前使用位置未确认绑定' : '符号使用关系 · 按声明绑定，条件分支未求值',
      sourceInsightReaderLocal: { id: value.id, generation: this.index.generation, symbol: { uri: value.uri, position: value.selectionRange.start } } };
  }
  get(item) {
    this.reset(); const handle = item.sourceInsightReaderLocal;
    if (!handle?.symbol || typeof handle.symbol.uri !== 'string' || !handle.symbol.position) return undefined;
    return this.nodes.get(handle.id) || this.index.definitions(handle.symbol.uri, handle.symbol.position)
      .filter(node => this.supports(node)).map(node => this.register(node)).find(node => node.id === handle.id);
  }
  owner(site, target) {
    const file = this.index.files.get(uriKey(site.uri)); if (!file) return undefined;
    const fn = file.functions.find(node => inside(node.range, site.range.start));
    if (fn) return this.index.item(fn);
    let owner;
    const visit = nodes => { for (const node of nodes) {
      if (!inside(node.range, site.range.start)) continue;
      if (identity(node) !== identity(target) && this.supports(node)) owner = node;
      visit(node.children || []);
    } };
    visit(file.symbols);
    if (owner) return this.item(owner);
    return { name: `${path.basename(file.path)}:${site.range.start.line + 1}`, kind: 0, uri: site.uri, range: site.range, selectionRange: site.range,
      detail: '文件作用域使用位置', sourceInsightReaderLocal: { id: `site:${uriKey(site.uri)}:${site.range.start.line}:${site.range.start.character}`, generation: this.index.generation, unresolved: true } };
  }
  uniqueMacro(name, uri) {
    if (!this.index.macroNames.has(name)) return undefined;
    const project = this.index.files.get(uriKey(uri))?.project || 'workspace';
    const symbols = this.index.storage ? this.index.candidateSymbols(name, uri, 'top')
      : [...this.index.files.values()].filter(file => (file.project || 'workspace') === project).flatMap(file => file.symbols);
    const macros = symbols.filter(node => node.name === name && node.category === 'macro');
    return macros.length === 1 ? macros[0] : undefined;
  }
  prepareCandidate(uri, token) {
    const target = this.uniqueMacro(token.name, uri);
    return target && this.macroCandidate(target)?.({ ...token, uri }) ? this.register({ ...target, relationCandidate: true }) : undefined;
  }
  macroCandidate(target) {
    if (target.category !== 'macro') return undefined;
    const unique = this.uniqueMacro(target.name, target.uri);
    if (!unique || identity(unique) !== identity(target)) return undefined;
    const project = this.index.files.get(uriKey(target.uri))?.project || 'workspace';
    const incomplete = new WeakMap();
    const before = (a, b) => a.line < b.line || a.line === b.line && a.character <= b.character;
    return token => {
      if (!['value', 'type'].includes(token.namespace)) return false;
      const file = this.index.files.get(uriKey(token.uri));
      if (!file || (file.project || 'workspace') !== project) return false;
      if ((file.undefs || []).some(event => !event.conditional && event.name === target.name && before(event.range.start, token.range.start))) return false;
      const visible = this.index.visible(token.uri, token.range.start);
      // An already-visible declaration failed binding for another reason, such
      // as order or undef. Never turn that failure into a name-only candidate.
      if (visible.has(uriKey(target.uri))) return false;
      const missing = this.index.missingIncludes.get(uriKey(token.uri)) || [];
      if (missing.some(include => !include.range || before(include.range.start, token.range.start))) return true;
      if (!incomplete.has(visible)) incomplete.set(visible, [...visible].some(uri => uri !== uriKey(token.uri) && this.index.missingIncludes.get(uri)?.length));
      return incomplete.get(visible);
    };
  }
  calls(item, direction) {
    const target = this.get(item); if (!target || direction === 'outgoing') return [];
    if (this.cache.has(target.id)) return this.cache.get(target.id);
    const groups = new Map(), deadline = Date.now() + 1500; let count = 0;
    for (const site of this.index.referenceSites(target.uri, target.selectionRange.start, { macroCandidates: true })) {
      if (++count % 64 === 0) {
        this.index.check();
        if (count > 20000 || Date.now() > deadline) { this.limited.add(target.id); break; }
      }
      if (!site || uriKey(site.uri) === uriKey(target.uri) && at(site.range.start, target.selectionRange.start)) continue;
      const from = this.owner(site, target); if (!from) continue;
      const id = from.sourceInsightReaderLocal.id;
      if (!groups.has(id)) groups.set(id, { from, fromRanges: [], siteLocations: [] });
      const group = groups.get(id);
      if (site.candidate) {
        this.candidates.add(target.id);
        group.from = { ...group.from, detail: '包含候选使用位置 · 工程内头文件包含链不完整，未确认宏绑定' };
      }
      if (group.siteLocations.some(value => uriKey(value.uri) === uriKey(site.uri) && at(value.range.start, site.range.start))) continue;
      group.fromRanges.push(site.range); group.siteLocations.push(site);
    }
    const result = [...groups.values()]; this.cache.set(target.id, result);
    if (this.cache.size > 256) { const first = this.cache.keys().next().value; this.cache.delete(first); this.limited.delete(first); this.candidates.delete(first); }
    return result;
  }
  diagnostics(item, direction) {
    const target = this.get(item); if (!target) return ['符号定义已变化，请刷新查询'];
    return [direction === 'incoming' ? '符号使用关系：按声明绑定，包含函数内、初始化和预处理引用；不包含自身定义' : '此符号不提供函数调用下游，请查看使用位置',
      ...(direction === 'incoming' && this.candidates.has(target.id) ? ['包含同名候选使用位置：宏定义在当前工程内，但头文件包含链不完整；候选不代表已确认绑定'] : []),
      ...(this.limited.has(target.id) ? ['符号使用关系达到时间或数量预算，当前结果不完整'] : []),
      ...(this.index.files.get(uriKey(target.uri))?.hasErrors ? ['当前文件含语法恢复或宏，符号使用关系可能不完整'] : [])];
  }
}
module.exports = { SymbolRelations };
