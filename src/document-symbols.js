'use strict';
const { sameUri } = require('./resources');

// Preprocessor entries are physical source navigation, not a replacement for C semantic parsing.
// Mask comments and strings without changing offsets; block comments/raw strings persist across lines.
function maskLine(text, state) {
  let result = '', index = 0;
  while (index < text.length) {
    if (state.rawEnd) {
      const end = text.indexOf(state.rawEnd, index);
      const next = end < 0 ? text.length : end + state.rawEnd.length;
      result += 'x' + ' '.repeat(Math.max(0, next - index - 1)); index = next;
      if (end < 0) break;
      state.rawEnd = ''; continue;
    }
    if (state.block) {
      const end = text.indexOf('*/', index);
      const next = end < 0 ? text.length : end + 2;
      result += ' '.repeat(next - index); index = next;
      if (end < 0) break;
      state.block = false; continue;
    }
    if (text.startsWith('//', index)) { result += ' '.repeat(text.length - index); break; }
    if (text.startsWith('/*', index)) { result += '  '; index += 2; state.block = true; continue; }
    const raw = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(text.slice(index));
    if (raw) {
      result += 'x' + ' '.repeat(raw[0].length - 1); index += raw[0].length;
      state.rawEnd = `)${raw[1]}"`; continue;
    }
    const quote = text[index];
    if (quote === '"' || quote === "'") {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === '\\') { end = Math.min(text.length, end + 2); continue; }
        if (text[end++] === quote) break;
      }
      result += quote + ' '.repeat(end - index - 1); index = end; continue;
    }
    result += text[index++];
  }
  return result;
}

function preprocessorSymbols(text, uri, makeRange) {
  const lines = text.split(/\r?\n/);
  const state = { block: false, rawEnd: '' };
  const entries = [];
  for (let line = 0; line < lines.length; line++) {
    const firstLine = line, spans = [];
    let logical = '';
    while (true) {
      const physical = lines[line];
      const continuation = /\\[\t ]*$/.exec(physical);
      const content = continuation && line < lines.length - 1 ? physical.slice(0, continuation.index) : physical;
      spans.push({ offset: logical.length, line, length: content.length }); logical += content;
      if (!continuation || line === lines.length - 1) break;
      line++;
    }
    const masked = maskLine(logical, state);
    const directive = /^\s*#\s*(include_next|include|define)\b/.exec(masked);
    if (!directive) continue;
    const payloadOffset = directive[0].length;
    const macro = directive[1] === 'define';
    const match = macro ? /^\s*([a-zA-Z_]\w*)/.exec(masked.slice(payloadOffset))
      : /^\s*(?:\/\*.*?\*\/\s*)*(<[^>]+>|"[^"\r\n]+"|[a-zA-Z_]\w*)/.exec(logical.slice(payloadOffset));
    if (!match) continue;
    const name = match[1];
    const delimited = !macro && /^[<"]/.test(name);
    const start = payloadOffset + match[0].lastIndexOf(name) + (delimited ? 1 : 0);
    const position = (offset, end = false) => {
      const span = [...spans].reverse().find(value => end ? value.offset < offset : value.offset <= offset) || spans[0];
      return { line: span.line, character: Math.min(span.length, offset - span.offset) };
    };
    const a = position(start), b = position(start + name.length - (delimited ? 2 : 0), true);
    entries.push({ type: 'symbol', name: macro ? name : `#${directive[1]} ${name}`, kind: macro ? 13 : 0,
      category: macro ? 'macro' : 'include', origin: 'source', uri, children: [], parent: undefined,
      detail: macro ? logical.slice(payloadOffset).trim().replace(/\s+/g, ' ').slice(0, 180) : name,
      range: makeRange(firstLine, 0, line, lines[line].length),
      selectionRange: makeRange(a.line, a.character, b.line, b.character) });
  }
  return entries;
}

function augmentDocumentSymbols(nodes, text, uri, makeRange) {
  const all = [];
  const visit = values => { for (const node of values) { all.push(node); visit(node.children); } };
  visit(nodes);
  const lines = text.split(/\r?\n/);
  for (const node of all) {
    if (node.kind !== 4 || !sameUri(node.uri, uri)) continue;
    const position = node.selectionRange.start;
    const prefix = (lines[position.line] || '').slice(0, position.character);
    const record = /\b(struct|union)\s*$/.exec(prefix);
    if (record) node.category = record[1];
  }
  for (const extra of preprocessorSymbols(text, uri, makeRange)) {
    const match = all.find(node => sameUri(node.uri, extra.uri) &&
      (node.name === extra.name || (extra.category === 'include' && node.kind === 0 && node.name === extra.detail.slice(1, -1))) &&
      node.selectionRange.start.line >= extra.range.start.line && node.selectionRange.start.line <= extra.range.end.line);
    if (match) {
      // Preserve provider positions/children, but identify actual #define entries independently of provider kind.
      match.category = extra.category; match.kind = extra.kind;
      if (!match.detail) match.detail = extra.detail;
    } else nodes.push(extra);
  }
  return nodes.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

function symbolCategory(node) {
  if (node.category === 'struct') return '结构体';
  if (node.category === 'union') return '联合体';
  if (node.category === 'include') return '头文件包含';
  if (node.category === 'macro') return '宏定义';
  const parentKind = node.parent?.kind;
  const global = parentKind === undefined || [0, 1, 2, 3].includes(parentKind);
  const categories = { 0: '文件', 1: '模块', 2: '命名空间', 3: '包', 4: '类型', 5: '方法',
    6: '属性', 7: '成员', 8: '构造函数', 9: '枚举', 10: '接口', 11: '函数',
    12: global ? '全局变量' : '变量', 13: global ? '全局常量' : '常量', 21: '枚举成员', 22: '结构体' };
  return categories[node.kind] || '符号';
}

module.exports = { preprocessorSymbols, augmentDocumentSymbols, symbolCategory };
