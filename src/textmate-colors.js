'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const vscode = require('vscode');
const { THEME_ID } = require('./theme');
const { textmateTheme } = require('./editor-color-settings');

class TextmateColors {
  constructor() { this.sequence = 0; this.pending = new Map(); }
  async colorize(document, start, end) {
    if (this.disposed || vscode.workspace.getConfiguration('workbench').get('colorTheme') !== THEME_ID) return [];
    const grammars = [];
    for (const extension of vscode.extensions?.all || []) for (const grammar of extension.packageJSON.contributes?.grammars || []) {
      if (grammar.scopeName && grammar.path) grammars.push({ language: grammar.language, scopeName: grammar.scopeName,
        path: path.resolve(extension.extensionPath, grammar.path), injectTo: grammar.injectTo });
    }
    if (!grammars.some(grammar => grammar.language === document.languageId)) return [];
    const editor = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: document.languageId });
    const theme = textmateTheme(vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations', {}),
      vscode.workspace.getConfiguration('workbench').get('colorCustomizations', {}));
    if (!this.worker) {
      this.worker = new Worker(path.join(__dirname, 'textmate-worker.js'));
      const worker = this.worker;
      worker.on('message', message => {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        pending.resolve(message.spans || []);
      });
      const failed = () => {
        if (this.worker !== worker) return;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve([]); }
        this.pending.clear(); if (this.worker === worker) this.worker = undefined;
        worker.terminate();
      };
      worker.on('error', failed); worker.on('exit', failed); worker.unref();
    }
    return new Promise(resolve => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); resolve([]); }, 5000);
      this.pending.set(id, { resolve, timer });
      this.worker.postMessage({ id, uri: document.uri.toString(), language: document.languageId,
        text: document.getText(), start, end, maxLine: editor.get('maxTokenizationLineLength', 20000), grammars, theme });
    });
  }
  dispose() {
    this.disposed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve([]); }
    this.pending.clear(); this.worker?.terminate(); this.worker = undefined;
  }
}
module.exports = { TextmateColors };
