'use strict';

// Bounded lexical coloring for previews; never produces HTML or claims semantic classification.
const supported = new Set(['c', 'cpp', 'cuda-cpp', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'json', 'jsonc']);
const keywords = new Set(('alignas alignof asm auto break case catch class concept const constexpr consteval constinit continue co_await co_return co_yield '
  + 'decltype default delete do else enum explicit export extern false final for friend goto if inline mutable namespace new noexcept nullptr operator '
  + 'override private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this '
  + 'thread_local throw true try typedef typeid typename union using virtual volatile while import from function let var async await yield extends '
  + 'implements interface package of in instanceof typeof void null undefined as').split(/\s+/));
const types = new Set('bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t string number boolean any never unknown'.split(' '));

function highlightLine(text, state = { block: false, rawEnd: '' }, languageId = 'cpp') {
  if (!supported.has(languageId) || text.length > 20000) return [{ text, kind: 'plain' }];
  const tokens = [];
  const push = (value, kind) => { if (value) tokens.push({ text: value, kind }); };
  let index = 0;
  while (index < text.length) {
    if (state.rawEnd) {
      const end = text.indexOf(state.rawEnd, index);
      if (end < 0) { push(text.slice(index), 'string'); break; }
      const next = end + state.rawEnd.length;
      push(text.slice(index, next), 'string'); index = next; state.rawEnd = ''; continue;
    }
    if (state.block) {
      const end = text.indexOf('*/', index);
      if (end < 0) { push(text.slice(index), 'comment'); break; }
      push(text.slice(index, end + 2), 'comment'); index = end + 2; state.block = false; continue;
    }
    const rest = text.slice(index);
    if (rest.startsWith('//')) { push(rest, 'comment'); break; }
    if (rest.startsWith('/*')) { state.block = true; push('/*', 'comment'); index += 2; continue; }
    if (text[index] === '#' && !text.slice(0, index).trim()) { push(rest, 'preprocessor'); break; }
    const raw = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(rest);
    if (raw) { push(raw[0], 'string'); index += raw[0].length; state.rawEnd = `)${raw[1]}"`; continue; }
    const quote = text[index];
    if (quote === '"' || quote === "'" || quote === '`') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === '\\') { end += 2; continue; }
        if (text[end++] === quote) break;
      }
      push(text.slice(index, end), 'string'); index = end; continue;
    }
    const number = /^(?:0[xX][\da-fA-F']+|0[bB][01']+|\d[\d']*(?:\.\d*)?(?:[eE][+-]?\d+)?)[uUlLfF]*/.exec(rest);
    if (number) { push(number[0], 'number'); index += number[0].length; continue; }
    const identifier = /^[a-zA-Z_$][\w$]*/.exec(rest);
    if (identifier) {
      const word = identifier[0];
      const kind = types.has(word) ? 'type' : keywords.has(word) ? 'keyword'
        : /^\s*\(/.test(rest.slice(word.length)) ? 'function' : 'plain';
      push(word, kind); index += word.length; continue;
    }
    const plain = /^(?:\s+|[^\w\s'"`/#]+)/.exec(rest)?.[0] || text[index];
    push(plain, 'plain'); index += plain.length;
  }
  return tokens;
}

module.exports = { highlightLine };
