'use strict';
const vscode = require('vscode');
const { symbolRanges, validSymbol } = require('../media/symbol-matches');
class SymbolHighlight {
  constructor(changed) {
    this.symbol = ''; this.changed = changed;
    this.decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('sourceInsightInspired.symbolHighlight.background'),
      color: new vscode.ThemeColor('sourceInsightInspired.symbolHighlight.foreground'),
      border: '1px solid', borderColor: new vscode.ThemeColor('sourceInsightInspired.symbolHighlight.border'),
      overviewRulerColor: new vscode.ThemeColor('sourceInsightInspired.symbolHighlight.border'),
      overviewRulerLane: vscode.OverviewRulerLane.Right
    });
    this.subscriptions = [vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      vscode.workspace.onDidChangeTextDocument(() => {
        clearTimeout(this.timer); this.timer = setTimeout(() => this.update(), 100);
      })];
  }
  toggle(symbol) {
    if (!validSymbol(symbol)) return false;
    this.symbol = this.symbol === symbol ? '' : symbol; this.update(); this.changed(this.symbol); return true;
  }
  clear() { this.symbol = ''; this.update(); this.changed(''); }
  update() {
    for (const editor of vscode.window.visibleTextEditors) {
      const ranges = symbolRanges(editor.document.getText(), this.symbol).map(range =>
        new vscode.Range(editor.document.positionAt(range.start), editor.document.positionAt(range.end)));
      editor.setDecorations(this.decoration, ranges);
    }
  }
  dispose() { clearTimeout(this.timer); this.subscriptions.forEach(item => item.dispose()); this.decoration.dispose(); }
}
module.exports = { SymbolHighlight };
