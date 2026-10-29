'use strict';
const { uriKey } = require('../resources');
const { identifiersNamed } = require('./identifier-table');
const at = (a, b) => a.line === b.line && a.character === b.character;
const inside = (range, point) => {
  const cmp = (a, b) => a.line - b.line || a.character - b.character;
  return cmp(range.start, point) <= 0 && cmp(point, range.end) < 0;
};
const identity = field => `${uriKey(field.uri)}#member:${field.selectionRange.start.line}:${field.selectionRange.start.character}`;
const slot = field => field.memberSlot || identity(field);

// Query the indexed occurrence catalog for one typed slot, rather than building
// every possible callback-to-driver edge at project startup. Assignments are
// candidates; no runtime dispatch or object-instance analysis is implied.
class MemberRelations {
  constructor(index) { this.index = index; this.generation = -1; this.nodes = new Map(); this.cache = new Map(); this.limitedKeys = new Set(); this.limited = false; }
  reset() {
    if (this.generation === this.index.generation) return;
    this.generation = this.index.generation; this.nodes.clear(); this.cache.clear(); this.limitedKeys.clear(); this.limited = false;
  }
  pointer(field, seen = new Set()) {
    if (field.functionPointer) return true;
    const name = field.declaredType?.name;
    if (!name || seen.has(name)) return false;
    seen.add(name);
    const visible = this.index.visible(field.uri, field.selectionRange.start);
    const values = this.index.storage ? this.index.candidateSymbols(name, field.uri)
      : [...this.index.files.values()].flatMap(file => file.symbols.filter(node => node.name === name));
    return values.some(node => visible.has(uriKey(node.uri)) && node.detail?.startsWith('typedef') && this.pointer(node, new Set(seen)));
  }
  register(field) {
    this.reset();
    const node = { ...field, id: identity(field), functionPointer: this.pointer(field) };
    this.nodes.set(node.id, node);
    if (this.nodes.size > 2048) this.nodes.delete(this.nodes.keys().next().value);
    return node;
  }
  get(item) {
    this.reset();
    const handle = item.sourceInsightReaderLocal;
    if (!handle?.member || typeof handle.member.uri !== 'string' || !handle.member.position) return undefined;
    return this.nodes.get(handle.id) || this.index.definitions(handle.member.uri, handle.member.position).filter(node => node.kind === 7).map(node => this.register(node)).find(node => node.id === handle.id);
  }
  item(field) {
    const node = this.register(field);
    return { name: node.name, uri: node.uri, range: node.range, selectionRange: node.selectionRange, kind: 7,
      detail: node.functionPointer ? '结构体函数指针成员 · 实现为静态赋值候选' : '结构体成员 · 类型绑定的使用关系',
      sourceInsightReaderLocal: { id: node.id, generation: this.index.generation, member: { uri: node.uri, position: node.selectionRange.start } } };
  }
  *sites(field) {
    this.reset(); this.limited = false;
    const project = this.index.files.get(uriKey(field.uri))?.project || 'workspace';
    const names = new Set([field.name, ...(field.memberAliases || [])]), seen = new Set(), deadline = Date.now() + 1500;
    let count = 0;
    for (const name of names) {
      const tokens = this.index.storage ? this.index.storage.occurrences(name, project) : (function* (index) {
        for (const file of index.files.values()) if ((file.project || 'workspace') === project)
          for (const token of identifiersNamed(file, name)) yield { ...token, uri: file.uri };
      })(this.index);
      for (const token of tokens) {
        if (++count % 64 === 0) { this.index.check(); if (Date.now() > deadline || count > 20000) { this.limited = true; return; } }
        if (token.namespace !== 'field') continue;
        const key = `${uriKey(token.uri)}:${token.range.start.line}:${token.range.start.character}`;
        if (seen.has(key)) continue;
        const values = this.index.definitions(token.uri, token.range.start);
        if (values.length === 1 && values[0].kind === 7 && slot(values[0]) === slot(field)) {
          seen.add(key); yield { uri: token.uri, range: token.range };
        }
      }
    }
  }
  calls(item, direction) {
    const field = this.get(item); if (!field) return [];
    const cacheKey = `${field.id}:${direction}`;
    if (this.cache.has(cacheKey)) { this.limited = this.limitedKeys.has(cacheKey); return this.cache.get(cacheKey); }
    if (direction === 'outgoing' && !field.functionPointer) return [];
    const groups = new Map();
    for (const site of this.sites(field)) {
      const file = this.index.files.get(uriKey(site.uri)); if (!file) continue;
      if (direction === 'incoming') {
        if (field.functionPointer && !file.calls.some(call => call.memberPosition && at(call.memberPosition, site.range.start))) continue;
        if (uriKey(field.uri) === uriKey(site.uri) && at(field.selectionRange.start, site.range.start)) continue;
        const fn = file.functions.find(fn => inside(fn.range, site.range.start)); if (!fn) continue;
        if (!groups.has(fn.id)) groups.set(fn.id, { from: this.index.item(fn), fromRanges: [] });
        groups.get(fn.id).fromRanges.push(site.range);
      } else if (field.functionPointer) {
        const assignment = (file.memberAssignments || []).find(value => at(value.position, site.range.start)); if (!assignment) continue;
        for (const target of this.index.definitions(file.uri, assignment.valuePosition).filter(value => value.id && this.index.functions.has(value.id))) {
          if (!groups.has(target.id)) groups.set(target.id, { to: { ...this.index.item(target), detail: '函数指针静态赋值候选 · 不代表运行时确定目标' }, fromRanges: [], siteLocations: [] });
          const group = groups.get(target.id); group.fromRanges.push(site.range); group.siteLocations.push(site);
        }
      }
    }
    const values = [...groups.values()]; this.cache.set(cacheKey, values);
    if (this.limited) this.limitedKeys.add(cacheKey);
    if (this.cache.size > 256) { const first = this.cache.keys().next().value; this.cache.delete(first); this.limitedKeys.delete(first); }
    return values;
  }
  fromFunction(fn) {
    this.reset();
    const file = this.index.files.get(uriKey(fn.uri)), groups = new Map();
    for (const call of file?.calls || []) {
      if (call.caller !== fn.id || !call.memberPosition) continue;
      const fields = this.index.definitions(file.uri, call.memberPosition).filter(field => field.kind === 7);
      if (fields.length !== 1 || !this.pointer(fields[0])) continue;
      const field = fields[0], id = identity(field);
      if (!groups.has(id)) groups.set(id, { to: this.item(field), fromRanges: [] });
      groups.get(id).fromRanges.push({ start: call.memberPosition, end: { line: call.memberPosition.line, character: call.memberPosition.character + field.name.length } });
    }
    return [...groups.values()];
  }
  toFunction(fn) {
    this.reset();
    const cacheKey = `to:${fn.id}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const project = this.index.files.get(uriKey(fn.uri))?.project || 'workspace';
    const tokens = this.index.storage ? this.index.storage.occurrences(fn.name, project) : (function* (index) {
      for (const file of index.files.values()) if ((file.project || 'workspace') === project)
        for (const token of identifiersNamed(file, fn.name)) yield { ...token, uri: file.uri };
    })(this.index);
    const groups = new Map(), fieldsSeen = new Set(), deadline = Date.now() + 1500;
    let count = 0, limited = false;
    const add = call => {
      const id = call.from.sourceInsightReaderLocal.id;
      if (!groups.has(id)) groups.set(id, { from: call.from, fromRanges: [], siteLocations: [] });
      const group = groups.get(id);
      for (const site of call.siteLocations || call.fromRanges.map(range => ({ uri: call.from.uri, range }))) {
        if (group.siteLocations.some(value => uriKey(value.uri) === uriKey(site.uri) && at(value.range.start, site.range.start))) continue;
        group.fromRanges.push(site.range); group.siteLocations.push(site);
      }
    };
    for (const token of tokens) {
      if (++count % 64 === 0) { this.index.check(); if (Date.now() > deadline || count > 20000) { limited = true; break; } }
      const file = this.index.files.get(uriKey(token.uri));
      const assignments = (file?.memberAssignments || []).filter(value => at(value.valuePosition, token.range.start));
      for (const assignment of assignments) {
        const targets = this.index.definitions(file.uri, assignment.valuePosition);
        if (targets.length !== 1 || targets[0].id !== fn.id) continue;
        const fields = this.index.definitions(file.uri, assignment.position).filter(field => field.kind === 7);
        if (fields.length !== 1 || !this.pointer(fields[0])) continue;
        const member = this.item(fields[0]);
        add({ from: { ...member, detail: '函数指针注册成员 · 静态赋值关联，展开查看成员调用位置' }, fromRanges: [assignment.range], siteLocations: [{ uri: file.uri, range: assignment.range }] });
        const slotId = slot(fields[0]);
        if (fieldsSeen.has(slotId)) continue;
        fieldsSeen.add(slotId);
        for (const caller of this.calls(member, 'incoming')) {
          add({ ...caller, from: { ...caller.from, detail: `函数指针回调调用候选 · 经 ${member.name} 成员赋值关联` } });
        }
        limited ||= this.limited;
      }
    }
    const result = [...groups.values()]; this.cache.set(cacheKey, result);
    if (limited) this.limitedKeys.add(cacheKey);
    if (this.cache.size > 256) { const first = this.cache.keys().next().value; this.cache.delete(first); this.limitedKeys.delete(first); }
    return result;
  }
  diagnostics(item, direction) {
    const field = this.get(item);
    if (!field) return ['成员定义已变化，请刷新查询'];
    return [field?.functionPointer ? '结构体函数指针：调用位置按成员类型绑定；实现仅为初始化或赋值候选，不代表运行时确定调用'
      : '结构体成员：列出类型绑定的使用位置；普通成员没有函数实现候选',
    ...(field?.memberAliases?.length ? ['匿名 union 中的函数指针别名共用同一成员槽'] : []),
    ...(this.index.files.get(uriKey(field.uri))?.hasErrors ? ['当前文件包含语法恢复或宏，成员关系可能不完整'] : []),
    ...(this.limitedKeys.has(`${field?.id}:${direction}`) ? ['成员关系达到时间或数量预算，当前结果不完整'] : [])];
  }
}
module.exports = { MemberRelations };
