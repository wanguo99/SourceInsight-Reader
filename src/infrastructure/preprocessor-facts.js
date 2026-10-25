'use strict';
const { withoutTrivia, cSourceProjection } = require('./c-source-projection');
const { WIDTH } = require('./identifier-table');
const keywords = new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local defined __VA_OPT__'.split(' '));

// Directives remain readable even when the grammar recovers an entire region
// as ERROR/preproc_arg. Never expand a macro or execute a build command here.
function preprocessorFacts(source, uri, cpp = false, check = () => {}) {
  const now = require('./resource-clock').extractionClock(check);
  const projected = cpp ? source : cSourceProjection(source, { keepDirectives: true });
  const code = withoutTrivia(projected), directives = withoutTrivia(projected, true), starts = [0], symbols = [], locals = [], tokens = [], undefs = [], includes = [], preprocessorRanges = [];
  let lexed = 0; const deadline = now() + 3000;
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  const point = offset => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= offset) lo = mid + 1; else hi = mid; }
    return { line: lo - 1, character: offset - starts[lo - 1] };
  };
  const range = (begin, end) => ({ start: point(begin), end: point(end) });
  const lex = (begin, end) => {
    let previous;
    for (const match of code.slice(begin, end).matchAll(/[A-Za-z_$][\w$]*|[0-9][\w.]*/g)) {
      if (++lexed % 1024 === 0) {
        check();
        if (lexed > 500000 || now() > deadline) throw new Error('单文件预处理名称提取超过资源预算');
      }
      if (/^[0-9]/.test(match[0]) || keywords.has(match[0])) { previous = undefined; continue; }
      const at = begin + match.index, between = previous ? code.slice(previous.end, at).trim() : '';
      const field = between === '.' || between === '->', tag = /\b(struct|union|enum)\s+$/.exec(code.slice(Math.max(begin, at - 30), at));
      tokens.push({ name: match[0], range: range(at, at + match[0].length), namespace: field ? 2 : tag ? 3 : 0,
        tag: tag ? ['struct', 'union', 'enum'].indexOf(tag[1]) + 1 : 0, receiver: field ? point(previous.start) : undefined });
      previous = { start: at, end: at + match[0].length };
    }
  };
  let depth = 0;
  for (let line = 0; line < starts.length; line++) {
    if (line % 256 === 0) check();
    const begin = starts[line], physicalEnd = starts[line + 1] ?? source.length;
    if (!/^[ \t]*#/.test(code.slice(begin, physicalEnd))) continue;
    const directive = /^([ \t]*#[ \t]*(\w+)[ \t]*)([^\r\n]*)/.exec(directives.slice(begin, physicalEnd));
    if (!directive) continue;
    const kind = directive[2], body = begin + directive[1].length;
    let end = physicalEnd;
    while (/\\[ \t]*\r?\n$/.test(source.slice(starts[line], end)) && line + 1 < starts.length) { line++; end = starts[line + 1] ?? source.length; }
    if (['if', 'ifdef', 'ifndef'].includes(kind)) depth++;
    if (kind === 'endif') depth = Math.max(0, depth - 1);
    if (kind === 'include') {
      const raw = projected.slice(body, end), target = /^\s*(["<])([^"<>\r\n]+)[">]/.exec(raw);
      if (target) includes.push({ name: target[2], quoted: target[1] === '"', range: range(begin, end) });
    }
    if (kind === 'define') {
      preprocessorRanges.push(range(body, end));
      const name = /^[A-Za-z_]\w*/.exec(code.slice(body, end));
      if (name) {
        const selectionRange = range(body, body + name[0].length);
        symbols.push({ name: name[0], uri, kind: 13, range: range(begin, end), selectionRange, detail: source.slice(begin, Math.min(end, begin + 180)).trim(), category: 'macro', origin: 'local', children: [] });
        const parameters = /^\(([^)]*)\)/.exec(code.slice(body + name[0].length, end));
        if (parameters) {
          const offset = body + name[0].length + 1;
          for (const param of parameters[1].matchAll(/[A-Za-z_]\w*|\.\.\./g)) {
            const at = offset + param.index, variadic = param[0] === '...';
            if (variadic && /[A-Za-z_]\w*\s*$/.test(parameters[1].slice(0, param.index))) continue;
            locals.push({ name: variadic ? '__VA_ARGS__' : param[0], uri, kind: 12, range: range(at, at + param[0].length), selectionRange: range(at, at + param[0].length),
              detail: '宏参数', category: 'macroParameter', children: [], scope: range(at, end) });
          }
        }
      }
    } else if (kind === 'undef') {
      const name = /^[A-Za-z_]\w*/.exec(code.slice(body, end));
      if (name) undefs.push({ name: name[0], range: range(body, body + name[0].length), conditional: depth > 0 });
    }
    lex(body, end);
  }
  // C++ binding remains semantic; a lexical occurrence table permits only
  // preprocessor navigation, never class/overload inference.
  if (cpp) { tokens.length = 0; lex(0, code.length); }
  return { symbols, locals, tokens, undefs, includes, preprocessorRanges };
}

function mergePreprocessorFacts(facts, collected) {
  const inDirective = range => {
    const point = range.start;
    return collected.preprocessorRanges.some(value => (value.start.line < point.line || value.start.line === point.line && value.start.character <= point.character) &&
      (value.end.line > point.line || value.end.line === point.line && value.end.character > point.character));
  };
  // Grammar recovery can misread `er.encoded += size` in an ASN.1 macro as a
  // global function declaration. Replacement text is not executable C here.
  facts.symbols = [...facts.symbols.filter(node => node.category !== 'macro' && !inDirective(node.selectionRange)), ...collected.symbols].sort((a, b) => a.selectionRange.start.line - b.selectionRange.start.line || a.selectionRange.start.character - b.selectionRange.start.character);
  facts.macros = [...new Set(collected.symbols.map(node => node.name))];
  facts.macroLocations = {};
  for (const node of collected.symbols) {
    if (!Object.hasOwn(facts.macroLocations, node.name)) Object.defineProperty(facts.macroLocations, node.name, { value: [], enumerable: true });
    facts.macroLocations[node.name].push(node.selectionRange.start);
  }
  facts.locals = [...facts.locals.filter(node => !inDirective(node.selectionRange)), ...collected.locals];
  facts.functions = facts.functions.filter(node => !inDirective(node.selectionRange)); facts.declarations = facts.declarations.filter(node => !inDirective(node.range)); facts.calls = facts.calls.filter(node => !inDirective(node.range));
  const functions = new Set(facts.functions.map(node => node.id)); facts.calls = facts.calls.filter(node => functions.has(node.caller));
  facts.undefs = collected.undefs; facts.includes = collected.includes; facts.preprocessorRanges = collected.preprocessorRanges;
  const names = new Map(facts.identifierNames.map((name, id) => [name, id])), extra = [];
  for (const token of collected.tokens) {
    if (!names.has(token.name)) { names.set(token.name, facts.identifierNames.length); facts.identifierNames.push(token.name); }
    extra.push([names.get(token.name), token.range.start.line, token.range.start.character, token.range.end.line, token.range.end.character, token.namespace, token.tag, token.receiver?.line ?? -1, token.receiver?.character ?? -1]);
  }
  extra.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
  const previous = facts.identifierData, output = []; let at = 0, index = 0;
  while (at < previous.length || index < extra.length) {
    const next = extra[index], order = next && at < previous.length ? previous[at + 1] - next[1] || previous[at + 2] - next[2] : at < previous.length ? -1 : 1;
    if (order < 0) { for (let i = 0; i < WIDTH; i++) output.push(previous[at + i]); at += WIDTH; }
    else { output.push(...next); index++; if (!order) at += WIDTH; }
  }
  facts.identifierData = Int32Array.from(output); return facts;
}
module.exports = { preprocessorFacts, mergePreprocessorFacts };
