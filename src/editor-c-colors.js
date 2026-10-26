'use strict';
const vscode = require('vscode');
const { scopedSettings } = require('./editor-color-settings');
const { semanticStyle } = require('./preview-colors');
const { uncoveredSpans } = require('./infrastructure/c-color-spans');

class EditorCColors {
  constructor(language, log = message => {}) {
    this.log = log; this.reported = new WeakMap();
    this.language = language; this.decorations = new Map(); this.applied = new WeakMap(); this.epoch = 0;
    this.subscriptions = [
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.window.onDidChangeTextEditorVisibleRanges?.(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument(event => {
        for (const editor of vscode.window.visibleTextEditors) if (editor.document === event.document) this.clear(editor);
        this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration(() => {
        this.reset(); this.schedule();
      }),
      language.catalog?.onDidChange?.(() => this.schedule())
    ].filter(Boolean);
    this.schedule();
  }
  enabled(document) { return this.language.allowed(document.uri) && this.language.localCColors.enabled(document); }
  schedule() {
    if (this.disposed) return;
    ++this.epoch; clearTimeout(this.timer); clearTimeout(this.poll);
    this.timer = setTimeout(() => { this.update().catch(() => {}); }, 100);
    this.timer.unref?.();
  }
  clear(editor) {
    for (const decoration of this.decorations.values()) editor.setDecorations(decoration, []);
    this.applied.delete(editor);
  }
  reset() {
    ++this.epoch;
    for (const editor of vscode.window.visibleTextEditors) this.clear(editor);
    for (const decoration of this.decorations.values()) decoration.dispose();
    this.decorations.clear();
  }
  async update() {
    clearTimeout(this.timer); clearTimeout(this.poll);
    if (this.disposed) return;
    const epoch = ++this.epoch, editors = [...vscode.window.visibleTextEditors];
    const documents = new Map();
    for (const editor of editors) {
      const document = editor.document;
      if (!this.enabled(document)) {
        this.report(document, this.language.localCColors.disabledReason?.(document) || 'outside reading scope');
        this.clear(editor); continue;
      }
      if (!documents.has(document)) documents.set(document, Promise.all([
        this.language.localColorTokens(document, editors.filter(view => view.document === document).flatMap(view => view.visibleRanges || [])).catch(() => []),
        this.language.semanticTokens(document.uri, document.languageId).catch(() => [])
      ]));
    }
    await Promise.all(editors.map(async editor => {
      const document = editor.document, version = document.version;
      const request = documents.get(document); if (!request) return;
      const [local, semantic] = await request;
      if (this.disposed || this.epoch !== epoch || document.version !== version || !this.enabled(document) ||
          !vscode.window.visibleTextEditors.includes(editor)) return;
      const visible = editor.visibleRanges || [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      const inView = span => visible.some(range => span.line >= range.start.line && span.line <= range.end.line);
      // Clangd marks EXPORT_SYMBOL's generated extern declaration on the
      // original argument. Correct this one source role even when semantic
      // tokens cover it. Explicitly render provider-confirmed macros with the
      // same theme rules as Context, even when native token styling is absent.
      const spans = [...uncoveredSpans(local.filter(inView), semantic), ...semantic.filter(span => (span.sourceReference || span.type === 'macro') && inView(span))].slice(0, 5000);
      const custom = vscode.workspace.getConfiguration('editor')
        .get('semanticTokenColorCustomizations', {});
      const overrides = scopedSettings(custom).map(layer => layer.rules || {}), groups = new Map(), applied = [];
      for (const span of spans) {
        const style = span.unresolved ? { foreground: new vscode.ThemeColor('editor.foreground'), bold: false, italic: false, underline: false, strikethrough: false }
          : semanticStyle(span.type, span.modifiers, document.languageId, overrides);
        const head = !span.unresolved && span.type === 'function' && span.modifiers.includes('declaration');
        const sourceReference = span.sourceReference === true;
        const referenceFontWeight = sourceReference && style.bold === undefined
          ? vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: document.languageId }).get('fontWeight', 'normal') : undefined;
        const key = JSON.stringify({ style, head, sourceReference, referenceFontWeight });
        if (!this.decorations.has(key)) {
          // Bounded by the finite syntax roles and their declaration/static
          // modifiers. Configuration changes dispose all old style handles.
          if (this.decorations.size >= 128) continue;
          this.decorations.set(key, vscode.window.createTextEditorDecorationType({ color: style.foreground,
            fontWeight: style.bold === undefined ? referenceFontWeight
              : style.bold ? head ? '900' : 'bold' : 'normal',
            letterSpacing: head && style.bold ? '0.5px' : undefined,
            fontStyle: style.italic === undefined ? sourceReference ? 'normal' : undefined : style.italic ? 'italic' : 'normal',
            textDecoration: [style.underline ? 'underline' : '', style.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
            rangeBehavior: vscode.DecorationRangeBehavior?.ClosedClosed }));
        }
        const ranges = groups.get(key) || []; ranges.push(new vscode.Range(span.line, span.start, span.line, span.end)); groups.set(key, ranges);
        applied.push({ ...span, style });
      }
      for (const [key, decoration] of this.decorations) editor.setDecorations(decoration, groups.get(key) || []);
      this.applied.set(editor, { version, spans: applied });
      this.report(document, `version=${version} local=${local.length} semantic=${semantic.length} visible=${applied.length} unresolved=${applied.filter(span => span.unresolved).length}`);
    }));
    // VS Code exposes no global semantic-token change event. Refresh only
    // visible C editors so a provider that becomes ready can reclaim its spans.
    if (!this.disposed && this.epoch === epoch && documents.size) {
      this.poll = setTimeout(() => { this.update().catch(() => {}); }, 3000); this.poll.unref?.();
    }
  }
  report(document, message) {
    if (this.reported.get(document) === message) return;
    this.reported.set(document, message); this.log(`[C colors] ${document.uri.toString()}: ${message}`);
  }
  dispose() {
    this.disposed = true; clearTimeout(this.timer); clearTimeout(this.poll);
    this.subscriptions.forEach(subscription => subscription.dispose()); this.reset();
  }
}
module.exports = { EditorCColors };
