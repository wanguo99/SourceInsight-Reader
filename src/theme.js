'use strict';
// Configuration can differ from the rendered theme in remote/automatic theme sessions.
// VS Code supplies the effective theme id on each webview body.
const THEME_ID = 'SourceInsight-Reader Source Insight';
let renderedTheme;
const listeners = new Set();
function effectiveTheme(configured) { return renderedTheme || configured; }
function observeTheme(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || id === renderedTheme) return;
  renderedTheme = id;
  for (const listener of listeners) listener(id);
}
function onDidChangeTheme(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }
module.exports = { THEME_ID, effectiveTheme, observeTheme, onDidChangeTheme };
