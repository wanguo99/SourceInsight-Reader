'use strict';
const vscode = require('vscode');
const { THEME_ID } = require('./theme');
const { sameUri } = require('./resources');
const { functionHeads } = require('./function-heads');

class FunctionHeadStyle {
  constructor(symbols) {
    this.symbols = symbols; this.cache = new WeakMap();
    this.decoration = vscode.window.createTextEditorDecorationType({ fontWeight: 'bold' });
    this.subscriptions = [symbols.onDidChangeTreeData(() => this.capture()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('workbench.colorTheme')) this.update();
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        this.cache.delete(event.document); this.update();
      })];
  }
  capture() {
    for (const editor of vscode.window.visibleTextEditors) {
      if (sameUri(editor.document.uri, this.symbols.uri)) this.cache.set(editor.document, {
        version: editor.document.version, ranges: functionHeads(this.symbols.nodes, editor.document)
      });
    }
    this.update();
  }
  update() {
    const enabled = vscode.workspace.getConfiguration('workbench').get('colorTheme') === THEME_ID;
    for (const editor of vscode.window.visibleTextEditors) {
      const cached = this.cache.get(editor.document);
      const ranges = enabled && cached?.version === editor.document.version ? cached.ranges : [];
      editor.setDecorations(this.decoration, ranges.map(range => new vscode.Range(range.start, range.end)));
    }
  }
  dispose() { this.subscriptions.forEach(item => item.dispose()); this.decoration.dispose(); }
}
module.exports = { FunctionHeadStyle };
