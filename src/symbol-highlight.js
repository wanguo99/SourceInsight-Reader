'use strict';
const vscode = require('vscode');
const { symbolRanges, validSymbol } = require('../media/symbol-matches');
const PIN_KEY = 'symbolHighlight.pinnedSymbol';
class SymbolHighlight {
  constructor(changed, state, fail = error => {}) {
    this.state = state; this.fail = fail; this.saved = Promise.resolve();
    this.count = 0; this.symbol = ''; this.changed = changed; this.ranges = new WeakMap();
    this.decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('sourceInsightReader.symbolHighlight.background'),
      color: new vscode.ThemeColor('sourceInsightReader.symbolHighlight.foreground'),
      border: '1px solid', borderColor: new vscode.ThemeColor('sourceInsightReader.symbolHighlight.border'),
      overviewRulerColor: new vscode.ThemeColor('sourceInsightReader.symbolHighlight.border'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    });
    this.subscriptions = [vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      vscode.workspace.onDidChangeTextDocument(() => {
        clearTimeout(this.timer); this.timer = setTimeout(() => this.update(), 100);
      })];
    const restored = state?.get(PIN_KEY, '');
    if (validSymbol(restored)) { this.symbol = restored; this.update(); this.changed(this.symbol); }
  }
  toggle(symbol) {
    if (!validSymbol(symbol)) return false;
    this.symbol = this.symbol === symbol ? '' : symbol; this.update(); this.changed(this.symbol); this.persist(); return true;
  }
  clear() { this.symbol = ''; this.update(); this.changed(''); this.persist(); }
  persist() {
    if (!this.state) return;
    const symbol = this.symbol;
    this.saved = this.saved.then(() => this.state.update(PIN_KEY, symbol || undefined)).catch(this.fail);
  }
  update() {
    this.count = 0;
    for (const editor of vscode.window.visibleTextEditors) {
      const document = editor.document, cached = this.ranges.get(document);
      const ranges = Number.isInteger(document.version) && cached?.version === document.version && cached.symbol === this.symbol ? cached.ranges
        : symbolRanges(this.symbol ? document.getText() : '', this.symbol).map(range =>
          new vscode.Range(document.positionAt(range.start), document.positionAt(range.end)));
      this.ranges.set(document, { version: document.version, symbol: this.symbol, ranges });
      this.count += ranges.length;
      editor.setDecorations(this.decoration, ranges);
    }
  }
  dispose() { clearTimeout(this.timer); this.subscriptions.forEach(item => item.dispose()); this.decoration.dispose(); }
}
module.exports = { SymbolHighlight };
