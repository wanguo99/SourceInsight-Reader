'use strict';
// A routing hint only: binding and ambiguity are decided by the typed index.
function memberSourceAt(document, point) {
  if (!document?.lineAt || point.line >= document.lineCount) return false;
  const lines = [];
  for (let line = Math.max(0, point.line - 2); line <= point.line; line++) lines.push(document.lineAt(line).text.slice(0, line === point.line ? point.character : undefined));
  return /(?:->|\.)\s*[\w$]*$|\(\s*\*\s*[\w$]*$/.test(lines.join('\n'));
}
module.exports = { memberSourceAt };
