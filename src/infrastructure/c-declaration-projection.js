'use strict';
const { isInvocation } = require('./identifier-table');
const { withoutTrivia, withoutDirectives } = require('./c-source-projection');

// These markers describe storage, calling conventions or sparse address spaces,
// not a different declarator. Do not expand arbitrary project macros.
const annotations = new Set(('asmlinkage noinline notrace __always_inline __noinline __init __initdata __initconst __exit __exitdata ' +
  '__ref __refdata __refconst __meminit __meminitdata __meminitconst __memexit __sched __visible __weak __noreturn __cold __hot ' +
  '__used __unused __maybe_unused __always_unused __must_check __pure __const __rcu __user __iomem __force __percpu __bitwise ' +
  '__nocast __read_mostly __ro_after_init __no_sanitize_address __no_sanitize_thread __no_sanitize_coverage __no_stack_protector ' +
  '__latent_entropy __no_kcsan __no_profile __nocfi noinstr __randomize_layout __no_randomize_layout ' +
  '__cacheline_aligned __cacheline_aligned_in_smp ____cacheline_aligned ____cacheline_aligned_in_smp').split(' '));
const perCpu = /^(?:DEFINE|DECLARE)_PER_CPU(?:_(?:SHARED_ALIGNED|ALIGNED|READ_MOSTLY|PAGE_ALIGNED))?$/;
const blank = value => value.replace(/[^\r\n]/g, ' ');
const typeWords = new Set('void char int float double long short signed unsigned struct union enum const volatile static extern register inline auto return goto break continue'.split(' '));

function cDeclarationProjection(source) {
  // Exclude directives (including their continuations), literals and comments.
  const code = withoutDirectives(withoutTrivia(source), source);
  const protectedNames = new Set();
  for (const match of code.matchAll(/\btypedef\b[^;{}]*\b([A-Za-z_]\w*)\s*;/g)) protectedNames.add(match[1]);
  const edits = [], preserved = [];
  for (const match of code.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    const name = match[0], start = match.index, end = start + name.length;
    if (annotations.has(name) && !protectedNames.has(name)) {
      const after = code.slice(end).match(/^\s*([A-Za-z_]\w*|\*)/);
      // A marker used as an actual variable, field or function name stays put.
      // A field access and return/goto expression cannot begin a declaration.
      const before = code.slice(Math.max(0, start - 64), start);
      const declaration = before.split(/[;{}]/).at(-1), suffix = declaration.match(/^\s*(?:[A-Za-z_]\w*\s+)+\**\s*([A-Za-z_]\w*)(?:\s*\[[^\]{};]*\])*\s*$/);
      const trailing = (suffix && !typeWords.has(suffix[1]) && !/^\s*(?:return|goto)\b/.test(declaration) || /}\s*$/.test(before) && /randomize_layout$/.test(name)) && /^\s*(?:[;,=\[)]|$)/.test(code.slice(end));
      if ((after || trailing) && !/(?:\.|->|\breturn|\bgoto)\s*$/.test(before)) { edits.push([start, end]); preserved.push(match); }
    } else if (perCpu.test(name) || /^for_each_[A-Za-z_]\w*$/.test(name) || /^(?:COMPAT_)?SYSCALL_DEFINE[1-6]$/.test(name)) {
      let at = end; while (/\s/.test(code[at] || '') && at < code.length) at++;
      if (code[at] !== '(') continue;
      const open = at, commas = []; let depth = 1;
      for (at++; at < code.length && depth; at++) {
        if ('([{'.includes(code[at])) depth++;
        else if (')]}'.includes(code[at])) depth--;
        else if (code[at] === ',' && depth === 1) commas.push(at);
      }
      if (depth) continue;
      const before = code.slice(Math.max(0, start - 128), start), next = code.slice(at).match(/^\s*(.)/)?.[1];
      if (/^for_each_/.test(name)) {
        if (!/(?:^|[\n;{}])\s*$/.test(before) || !next || [';', ',', ')', '='].includes(next)) continue;
        edits.push([start, end, 'if' + ' '.repeat(name.length - 2)]); preserved.push(match); continue;
      }
      if (/SYSCALL_DEFINE/.test(name)) {
        const arity = Number(name.at(-1));
        if (next !== '{' || commas.length !== arity * 2 || !/^[A-Za-z_]\w*$/.test(code.slice(open + 1, commas[0]).trim())) continue;
        edits.push([start, open + 1, 'void' + blank(source.slice(start + 4, open + 1))], [commas[0], commas[0] + 1, '(']);
        for (let i = 1; i < commas.length; i += 2) edits.push([commas[i], commas[i] + 1]);
        preserved.push(match); continue;
      }
      if (commas.length !== 1) continue;
      const close = at - 1, type = code.slice(open + 1, commas[0]).trim(), declarator = code.slice(commas[0] + 1, close).trim();
      if (!/^(?:(?:struct|union|enum)\s+)?[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*(?:\s*\*)*$/.test(type) ||
        !/^[A-Za-z_]\w*(?:\s*\[[^\]{};]*\])*$/.test(declarator)) continue;
      if (![';', '='].includes(next)) continue;
      edits.push([start, open + 1], [commas[0], commas[0] + 1], [close, close + 1]); preserved.push(match);
    }
  }
  if (!edits.length) return { source, tokens: [] };
  const starts = [0]; for (let at = 0; at < source.length; at++) if (source[at] === '\n') starts.push(at + 1);
  const point = offset => {
    let lo = 0, hi = starts.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= offset) lo = mid + 1; else hi = mid; }
    return { line: lo - 1, character: offset - starts[lo - 1] };
  };
  const tokens = preserved.map(match => ({ name: match[0], namespace: 0, tag: 0, invoked: isInvocation(source, match.index + match[0].length),
    range: { start: point(match.index), end: point(match.index + match[0].length) } }));
  edits.sort((a, b) => a[0] - b[0]); const chunks = []; let offset = 0;
  for (const [begin, end, replacement] of edits) { if (end <= offset) continue; chunks.push(source.slice(offset, Math.max(offset, begin)), replacement ?? blank(source.slice(Math.max(offset, begin), end))); offset = end; }
  chunks.push(source.slice(offset)); return { source: chunks.join(''), tokens };
}
module.exports = { cDeclarationProjection };
