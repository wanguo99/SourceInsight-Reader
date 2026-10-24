'use strict';
const crypto = require('node:crypto');
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function createAnchor(text, line, character = 0) {
  const lines = text.split(/\r\n|\n|\r/);
  if (!Number.isInteger(line) || line < 0 || line >= lines.length || !lines[line].trim()) throw new Error('请选择包含代码的行');
  return { line, character, text: lines[line], before: lines[line - 1], after: lines[line + 1], hash: digest(text) };
}
function locateAnchor(text, anchor) {
  const lines = text.split(/\r\n|\n|\r/);
  if (digest(text) === anchor.hash && lines[anchor.line] === anchor.text) return { status: 'exact', line: anchor.line, character: Math.min(anchor.character, anchor.text.length) };
  const matches = [];
  for (let line = 0; line < lines.length; line++) if (lines[line] === anchor.text) matches.push(line);
  const context = matches.filter(line => (anchor.before === undefined || lines[line - 1] === anchor.before) && (anchor.after === undefined || lines[line + 1] === anchor.after));
  const candidates = context.length ? context : matches;
  if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous' : 'missing' };
  return { status: 'relocated', line: candidates[0], character: Math.min(anchor.character, anchor.text.length) };
}
module.exports = { createAnchor, locateAnchor };
