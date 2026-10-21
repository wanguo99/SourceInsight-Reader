'use strict';

// Preview-only lexical classification. Original text and UTF-16 offsets are
// preserved; this does not replace a compiler's semantic classification.
const supported = new Set(['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'json', 'jsonc', 'java', 'python']);
const keywords = new Set(('alignas alignof asm auto break case catch class concept const constexpr consteval constinit continue co_await co_return co_yield '
  + 'decltype default delete do else enum explicit export extern false final for friend goto if inline mutable namespace new noexcept nullptr operator '
  + 'override private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this '
  + 'thread_local throw true try typedef typeid typename union using virtual volatile while import from function let var async await yield extends '
  + 'implements interface package of in instanceof typeof void null undefined as _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local restrict').split(/\s+/));
const controls = new Set('if else for while switch case default break continue return goto do try catch throw finally yield'.split(' '));
const types = new Set('bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t ptrdiff_t ssize_t intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t _Bool _Complex _Imaginary string number boolean any never unknown'.split(' '));
const pythonKeywords = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '));
const javaKeywords = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum exports extends final finally float for if implements import instanceof int interface long module native new opens package permits private protected provides public record requires return sealed short static strictfp super switch synchronized this throw throws to transient transitive try uses var void volatile while with yield true false null'.split(' '));
const caches = new WeakMap();
const initial = () => ({ block: false, rawEnd: '', quote: '', directive: false, expectType: false });

function stringEnd(text, delimiter, from) {
  let end = text.indexOf(delimiter, from);
  // Python triple strings and Java text blocks may contain escaped delimiters.
  while (end >= 0 && /(?:^|[^\\])(?:\\\\)*\\$/.test(text.slice(0, end))) end = text.indexOf(delimiter, end + 1);
  return end;
}

function highlightLine(text, state = initial(), languageId = 'cpp') {
  if (!supported.has(languageId) || text.length > 20000) return [{ text, kind: 'plain' }];
  const python = languageId === 'python', java = languageId === 'java';
  const languageKeywords = python ? pythonKeywords : java ? javaKeywords : keywords;
  const c = ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp'].includes(languageId);
  const tokens = [], push = (value, kind) => { if (value) tokens.push({ text: value, kind }); };
  let index = 0, directive = Boolean(state.directive), include = false, macroName = false, member = false;
  state.directive = false;
  const string = (quote, begin) => {
    let end = begin;
    while (end < text.length) {
      if (text[end] === '\\') { end += 2; continue; }
      if (text[end++] === quote) { state.quote = ''; return Math.min(end, text.length); }
    }
    // Backslash-newline splicing in C, or a JavaScript template literal.
    state.quote = quote === '`' || /(?:^|[^\\])(?:\\\\)*\\$/.test(text) ? quote : '';
    return text.length;
  };
  while (index < text.length) {
    if (state.rawEnd) {
      const end = python || java ? stringEnd(text, state.rawEnd, index) : text.indexOf(state.rawEnd, index);
      if (end < 0) { push(text.slice(index), 'string'); break; }
      const next = end + state.rawEnd.length;
      push(text.slice(index, next), 'string'); index = next; state.rawEnd = ''; continue;
    }
    if (state.quote) { const end = string(state.quote, index); push(text.slice(index, end), 'string'); index = end; continue; }
    if (state.block) {
      const end = text.indexOf('*/', index);
      if (end < 0) { push(text.slice(index), 'comment'); break; }
      push(text.slice(index, end + 2), 'comment'); index = end + 2; state.block = false; continue;
    }
    const rest = text.slice(index);
    if (python && rest.startsWith('#')) { push(rest, 'comment'); break; }
    if (!python && rest.startsWith('//')) { push(rest, 'comment'); break; }
    if (!python && rest.startsWith('/*')) { state.block = true; push('/*', 'comment'); index += 2; continue; }
    const preprocessor = c && !text.slice(0, index).trim() && /^#\s*([a-zA-Z_]\w*)/.exec(rest);
    if (preprocessor) {
      push(preprocessor[0], 'preprocessor'); index += preprocessor[0].length; directive = true;
      include = /^(include|include_next|import)$/.test(preprocessor[1]); macroName = preprocessor[1] === 'define'; continue;
    }
    if (include && text[index] === '<') {
      const end = text.indexOf('>', index + 1); const next = end < 0 ? text.length : end + 1;
      push(text.slice(index, next), 'string'); index = next; include = false; continue;
    }
    const multiline = python ? /^(?:[rRuUbBfF]{0,2})("""|''')/.exec(rest) : java ? /^(""")/.exec(rest) : null;
    if (multiline) {
      const begin = index, delimiter = multiline[1];
      index += multiline[0].length;
      const end = stringEnd(text, delimiter, index);
      if (end < 0) { push(text.slice(begin), 'string'); state.rawEnd = delimiter; break; }
      index = end + delimiter.length; push(text.slice(begin, index), 'string'); continue;
    }
    const raw = c && /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(rest);
    if (raw) { push(raw[0], 'string'); index += raw[0].length; state.rawEnd = `)${raw[1]}"`; continue; }
    const quoted = (python ? /^(?:[rRuUbBfF]{0,2})(["'])/ : /^(?:u8|u|U|L)?(["'])/).exec(rest);
    if (quoted || !python && !java && text[index] === '`') {
      const quote = quoted ? quoted[1] : '`', prefix = quoted ? quoted[0].length : 1;
      const end = string(quote, index + prefix); push(text.slice(index, end), 'string'); index = end; include = false; continue;
    }
    const number = /^(?:0[xX][\da-fA-F']+(?:\.[\da-fA-F']*)?(?:[pP][+-]?\d+)?|0[bB][01']+|(?:\d[\d']*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)[uUlLfF]*/.exec(rest);
    if (number) { push(number[0], 'number'); index += number[0].length; continue; }
    const identifier = /^[a-zA-Z_$][\w$]*/.exec(rest);
    if (identifier) {
      const word = identifier[0];
      const kind = macroName ? 'macro' : !python && types.has(word) ? 'type' : languageKeywords.has(word) ? (controls.has(word) ? 'control' : 'keyword')
        : state.expectType || c && /_t$/.test(word) ? 'type' : c && /^[A-Z_][A-Z0-9_]+$/.test(word) ? 'macro'
          : member ? 'property' : /^\s*\(/.test(rest.slice(word.length)) ? 'function' : 'plain';
      push(word, kind); index += word.length; macroName = false; member = false;
      state.expectType = /^(struct|union|enum|class|typename)$/.test(word); continue;
    }
    const plain = /^(?:\s+|[^\w\s'"`/#.]+)/.exec(rest)?.[0] || text[index];
    if (/\S/.test(plain)) {
      member = /(?:->|\.)\s*$/.test(plain);
      if (/[{};()]/.test(plain)) state.expectType = false;
    }
    push(plain, 'plain'); index += plain.length;
  }
  state.directive = directive && /\\\s*$/.test(text);
  return tokens;
}

function highlightDocument(document, start, end) {
  let cache = caches.get(document);
  if (!cache || cache.version !== document.version || cache.language !== document.languageId) {
    cache = { version: document.version, language: document.languageId, checkpoints: new Map([[0, initial()]]) };
    caches.set(document, cache);
  }
  let from = 0;
  for (const line of cache.checkpoints.keys()) if (line <= start && line > from) from = line;
  const state = { ...cache.checkpoints.get(from) }, lines = [];
  for (let line = from; line <= end; line++) {
    const tokens = highlightLine(document.lineAt(line).text, state, document.languageId);
    if (line >= start) lines.push(tokens);
    if ((line + 1) % 128 === 0) cache.checkpoints.set(line + 1, { ...state });
  }
  return lines;
}
module.exports = { highlightLine, highlightDocument };
