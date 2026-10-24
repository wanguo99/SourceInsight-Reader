'use strict';

const blank = value => value.replace(/[^\r\n]/g, ' ');
const trivia = /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;
function withoutTrivia(source, commentsOnly = false) {
  return source.replace(trivia, value => !commentsOnly || value.startsWith('/') ? blank(value) : value);
}

// Only __cplusplus has a fixed meaning in this C parser. Other build flags
// remain unknown; both branches are retained rather than guessing a build.
function cppCondition(expression, nesting = 0) {
  if (nesting > 32 || expression.length > 8192) return undefined;
  let text = expression.trim();
  while (text.startsWith('(') && text.endsWith(')')) {
    let depth = 0, outer = true;
    for (let at = 0; at < text.length - 1; at++) { if (text[at] === '(') depth++; else if (text[at] === ')') depth--; if (!depth) { outer = false; break; } }
    if (!outer) break; text = text.slice(1, -1).trim();
  }
  for (const operator of ['||', '&&']) {
    let depth = 0;
    for (let at = 0; at < text.length - 1; at++) {
      if (text[at] === '(') depth++; else if (text[at] === ')') depth--;
      if (!depth && text.slice(at, at + 2) === operator) {
        const left = cppCondition(text.slice(0, at), nesting + 1), right = cppCondition(text.slice(at + 2), nesting + 1);
        return operator === '||' ? left === true || right === true ? true : left === false && right === false ? false : undefined
          : left === false || right === false ? false : left === true && right === true ? true : undefined;
      }
    }
  }
  if (text.startsWith('!')) { const value = cppCondition(text.slice(1), nesting + 1); return value === undefined ? undefined : !value; }
  if (/^(?:__cplusplus|defined\s*(?:\(\s*__cplusplus\s*\)|__cplusplus))$/.test(text)) return false;
  if (/^[01]$/.test(text)) return text === '1';
}

// The projection changes only syntax irrelevant to C name binding and keeps
// every UTF-16 offset/line ending. Original source is never written back.
function cSourceProjection(source) {
  const code = withoutTrivia(source), edits = [], stack = [], braces = [];
  let active = true, parentheses = 0, previous = '', continuation = false;
  const lines = /[^\n]*(?:\n|$)/g;
  for (const match of source.matchAll(lines)) {
    if (!match[0]) continue;
    const start = match.index, end = start + match[0].length, line = code.slice(start, end);
    if (continuation) {
      if (!active) edits.push([start, end]);
      continuation = /\\\s*(?:\r?\n)?$/.test(match[0]); continue;
    }
    const directive = /^\s*#\s*(\w+)\b([^\r\n]*)/.exec(line);
    if (directive) {
      const [, kind, expression] = directive;
      if (['if', 'ifdef', 'ifndef'].includes(kind)) {
        const condition = kind === 'if' ? expression.includes('__cplusplus') ? cppCondition(expression) : undefined
          : expression.trim() === '__cplusplus' ? kind === 'ifndef' : undefined;
        const frame = { parent: active, taken: condition }; stack.push(frame);
        active = frame.parent && condition !== false;
      } else if (kind === 'elif' && stack.length) {
        const frame = stack.at(-1), condition = expression.includes('__cplusplus') ? cppCondition(expression) : undefined;
        active = frame.parent && frame.taken !== true && condition !== false;
        frame.taken = frame.taken === true || condition === true ? true : frame.taken === false && condition === false ? false : undefined;
      } else if (kind === 'else' && stack.length) {
        const frame = stack.at(-1); active = frame.parent && frame.taken !== true; frame.taken = true;
      } else if (kind === 'endif' && stack.length) active = stack.pop().parent;
      const conditional = /^(?:if|ifdef|ifndef|elif|else|endif)$/.test(kind);
      // C grammar does not allow directives inside signatures, calls or array/
      // enum initializers. Retain all unknown-branch contents in those contexts.
      if (!conditional && !active || conditional && (parentheses > 0 || braces.at(-1) === 'initializer' || braces.at(-1) === 'enum')) edits.push([start, end]);
      continuation = /\\\s*(?:\r?\n)?$/.test(match[0]); continue;
    }
    if (!active) { edits.push([start, end]); continue; }
    for (let at = 0; at < line.length; at++) {
      const char = line[at]; if (/\s/.test(char)) continue;
      if (char === '(') parentheses++; else if (char === ')') parentheses = Math.max(0, parentheses - 1);
      else if (char === '{') braces.push(previous === '=' || braces.at(-1) === 'initializer' ? 'initializer'
        : /\benum\s*(?:[A-Za-z_]\w*\s*)?$/.test(code.slice(Math.max(0, start + at - 100), start + at)) ? 'enum' : 'block');
      else if (char === '}') braces.pop();
      previous = char;
    }
  }
  // GCC attributes can follow declarators, a position this grammar does not
  // consistently accept. Their metadata does not determine local symbol names.
  for (const match of code.matchAll(/\b__attribute__?\s*\(/g)) {
    let at = match.index + match[0].length, depth = 1;
    for (; at < code.length && depth; at++) { if (code[at] === '(') depth++; else if (code[at] === ')') depth--; }
    if (!depth) edits.push([match.index, at]);
  }
  if (!edits.length) return source;
  edits.sort((a, b) => a[0] - b[0]);
  const output = []; let offset = 0;
  for (const [begin, stop] of edits) {
    if (stop <= offset) continue;
    if (begin > offset) output.push(source.slice(offset, begin));
    output.push(blank(source.slice(Math.max(begin, offset), stop))); offset = stop;
  }
  output.push(source.slice(offset)); return output.join('');
}

module.exports = { cSourceProjection, withoutTrivia };
