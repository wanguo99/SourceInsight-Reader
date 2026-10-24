'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const vscode = require('vscode');
const { THEME_ID } = require('./theme');
const { textmateTheme } = require('./editor-color-settings');

class TextmateColors {
  constructor() { this.sequence = 0; this.pending = new Map(); this.sent = new Map(); this.documentIds = new WeakMap(); this.documentSequence = 0; }
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
        if (message.needsText && !pending.retried && !pending.document.isClosed && pending.document.version === pending.message.version) {
          pending.retried = true; worker.postMessage({ ...pending.message, text: pending.document.getText() }); return;
        }
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (!message.error && !message.needsText) {
          this.sent.set(pending.message.uri, `${pending.message.documentId}:${pending.message.version}`);
          while (this.sent.size > 4) this.sent.delete(this.sent.keys().next().value);
        }
        pending.resolve(message.spans || []);
      });
      const failed = () => {
        if (this.worker !== worker) return;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve([]); }
        this.pending.clear(); this.sent.clear(); if (this.worker === worker) this.worker = undefined;
        worker.terminate();
      };
      worker.on('error', failed); worker.on('exit', failed); worker.unref();
    }
    return new Promise(resolve => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        const worker = this.worker; this.worker = undefined; this.sent.clear();
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve([]); }
        this.pending.clear(); worker?.terminate();
      }, 5000);
      if (!this.documentIds.has(document)) this.documentIds.set(document, ++this.documentSequence);
      const documentId = this.documentIds.get(document), version = document.version, uri = document.uri.toString();
      const message = { id, uri, documentId, version, language: document.languageId,
        text: this.sent.get(uri) === `${documentId}:${version}` ? undefined : document.getText(),
        start, end, maxLine: editor.get('maxTokenizationLineLength', 20000), grammars, theme };
      this.pending.set(id, { resolve, timer, document, message, retried: false });
      this.worker.postMessage(message);
    });
  }
  dispose() {
    this.disposed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve([]); }
    this.pending.clear(); this.sent.clear(); this.worker?.terminate(); this.worker = undefined;
  }
}
module.exports = { TextmateColors };
