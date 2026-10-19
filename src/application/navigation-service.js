'use strict';
const vscode = require('vscode');
const { RequestGate, locationKey } = require('../core');
const { sameUri } = require('../resources');
class NavigationService {
  constructor(services) { this.session = services.session; this.language = services.language; this.preview = services.preview; this.symbols = services.symbols; this.references = services.references; this.referenceSession = services.referenceSession; this.relations = services.relations; this.follow = services.follow; this.jumpGate = new RequestGate(); this.navigationGate = new RequestGate(); }
  source(node) {
    if (node?.uri) return {
      uri: node.uri, range: node.selectionRange || node.range || new vscode.Range(0, 0, 0, 0), name: node.name
    };
    if (!this.session.editor || this.session.editor.document.isClosed) return;
    const editor = this.session.editor;
    const position = editor.selection.active;
    const word = editor.document.getWordRangeAtPosition(position);
    return { uri: editor.document.uri, range: new vscode.Range(position, position),
      name: word ? editor.document.getText(word) : undefined };
  }
  readingPosition() {
    if (!this.session.editor || this.session.editor.document.isClosed) return;
    return { uri: this.session.editor.document.uri,
      range: new vscode.Range(this.session.editor.selection.start, this.session.editor.selection.end) };
  }
  async selectTarget(node) {
    if (!node?.uri || !['relation', 'reference', 'callsite', 'file', 'symbol'].includes(node.type)) return;
    if (node.type === 'reference') this.session.currentReference = node;
    this.follow.cancel(); this.preview.invalidateAuto();
    this.session.previewKey = undefined;
    const source = { ...this.source(node), mode: ['relation', 'symbol'].includes(node.type) ? '定义'
      : node.type === 'callsite' ? '调用现场' : node.type === 'file' ? '文件预览' : '引用现场' };
    await this.preview.show(source);
  }
  async setDirection(direction, node) {
    this.follow.cancel();
    if (!node?.uri && this.relations.root) { this.relations.switchDirection(direction); return; }
    const source = node?.uri ? this.source(node) : this.relations.source || this.source();
    this.relations.direction = direction;
    this.relations.publish();
    if (source) await this.relations.setRoot(source, { manual: true, interactive: true });
  }
  async openTarget(source, record = true, preview = false) {
    if (!source) return;
    this.follow.cancel();
    this.jumpGate.invalidate(); this.preview.invalidateAuto();
    const request = this.navigationGate.next();
    this.session.previewKey = undefined;
    const origin = this.readingPosition();
    this.session.navigationDepth++;
    try {
      const document = await vscode.workspace.openTextDocument(source.uri);
      if (!this.navigationGate.current(request)) return;
      const range = document.validateRange(source.range);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: this.session.editor?.viewColumn || vscode.ViewColumn.One,
        selection: range, preview, preserveFocus: preview
      });
      if (!this.navigationGate.current(request)) return;
      this.session.editor = editor;
      if (record && origin) this.session.history.push(origin);
      if (record) this.session.history.push({ ...source, range });
      await this.follow.acceptEditor(editor);
      if (!sameUri(this.symbols.uri, source.uri)) await this.follow.reloadSymbols();
    } finally {
      this.session.navigationDepth--;
      this.session.position = this.readingPosition();
    }
  }
  async navigate(direction) {
    // Capture any manual movement since the last explicit jump before going back.
    if (direction === 'back') {
      const source = this.readingPosition(); if (source) this.session.history.push(source);
    }
    const destination = direction === 'back' ? this.session.history.back() : this.session.history.forward();
    if (destination) await this.openTarget(destination, false);
  }
  dispose() { this.jumpGate.dispose(); this.navigationGate.dispose(); }
}
module.exports = { NavigationService };
