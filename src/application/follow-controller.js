'use strict';
const { RequestGate, enclosingFunction, locationKey } = require('../core');
const { target } = require('../trees');
const { sameUri } = require('../resources');
class FollowController {
  constructor(services) { this.session = services.session; this.symbols = services.symbols; this.symbolView = services.symbolView; this.fileSearchView = services.fileSearchView; this.preview = services.preview; this.relations = services.relations; this.navigation = services.navigation; this.config = services.config; this.run = services.run; this.mainGate = new RequestGate(); this.followGate = new RequestGate(); this.disposed = false; }
  syncSymbolDescription() {
    const uri = this.symbols.uri;
    const filename = uri?.path.split('/').pop();
    this.symbolView.title = filename ? `文件符号 · ${filename}` : '文件符号';
    // A single-view container can hide/merge its native view title. Keep the
    // filename visible inside the tree's fixed message area as well.
    this.symbolView.message = filename ? `当前文件：${filename}` : '当前文件：未打开源码文件';
    this.symbolView.description = `${this.symbols.allSymbols ? '全部符号' : '函数'} · ${this.symbols.sort === 'name' ? '名称排序' : '源码顺序'}${this.symbols.query ? ` · ${this.symbols.query}` : ''}${uri ? ` · ${uri.fsPath || uri.path}` : ''}`;
  }
  relationSource(fn, source) {
    if (!source || !this.session.editor) return fn ? target(fn) : source;
    const document = this.session.editor.document;
    const word = document.getWordRangeAtPosition(source.range.start);
    if (word) {
      const name = document.getText(word);
      const rest = document.lineAt(word.end.line).text.slice(word.end.character);
      if (/^\s*\(/.test(rest) && !/^(if|for|while|switch|sizeof|typeof|_Alignof)$/.test(name)) {
        return { ...source, range: word, name };
      }
    }
    return fn ? target(fn) : source;
  }
  cancel() { clearTimeout(this.followTimer); this.followGate.invalidate(); }
  async acceptEditor(editor) {
    // Webview focus emits undefined; preserve the last main text editor.
    if (this.disposed || !editor || editor.document.isClosed || editor.document.uri.scheme === 'output') return;
    const changedFile = !sameUri(this.session.editor?.document.uri, editor.document.uri);
    const previous = this.navigation.readingPosition();
    if (changedFile && previous && !this.session.navigationDepth) this.session.history.push(previous);
    this.session.editor = editor;
    this.run(() => this.fileSearchView.revealFile(editor.document.uri));
    this.session.position = this.navigation.readingPosition();
    if (changedFile && !this.session.navigationDepth) this.session.history.push(this.session.position);
    if (changedFile) {
      this.mainGate.invalidate(); this.preview.invalidateAuto();
      if (!this.relations.locked) this.relations.invalidate();
      this.session.relationKey = undefined;
      await this.reloadSymbols();
    } else this.schedule();
  }
  async reloadSymbols() {
    if (this.disposed || !this.session.editor || this.session.editor.document.isClosed) return;
    const request = this.mainGate.next();
    const uri = this.session.editor.document.uri;
    const loading = this.symbols.load(uri);
    this.syncSymbolDescription();
    const valid = await loading;
    if (valid && this.mainGate.current(request)) { this.session.previewKey = undefined; this.schedule(); }
  }
  schedule() {
    if (this.disposed) return;
    this.cancel();
    this.followTimer = setTimeout(() => this.run(() => this.follow()), this.config('debounceMs', 250));
  }
  async follow() {
    const request = this.followGate.next();
    const source = this.navigation.source(); if (!source) return;
    const nodesMatch = sameUri(this.symbols.uri, source.uri);
    const fn = nodesMatch ? enclosingFunction(this.symbols.nodes, source.range.start) : undefined;
    if (this.symbolView.visible) {
      const selected = fn && this.symbols.findDisplayed(locationKey(target(fn)));
      if (selected) {
        this.session.revealingSymbols++;
        try { await this.symbolView.reveal(selected, { select: true, focus: false, expand: true }); }
        finally { this.session.revealingSymbols--; }
      }
      else if (this.symbolView.selection.length) {
        // TreeView has no public clear-selection API; remove stale selection through a render reset.
        this.symbols.clearSelection();
      }
    }
    if (!this.followGate.current(request)) return;
    const tasks = [];
    if (this.config('autoPreview', true) && !this.preview.locked) {
      const document = this.session.editor.document;
      const selectedWord = document.getWordRangeAtPosition(source.range.start);
      const word = selectedWord || source.range;
      const mode = this.config('contextMode', 'definition');
      const key = `${locationKey({ uri: source.uri, range: word })}@${document.version}:${mode}`;
      if (this.session.previewKey !== key && (selectedWord || mode === 'enclosing')) {
        this.session.previewKey = key;
        tasks.push(mode === 'enclosing' && fn
          ? this.preview.show({ ...target(fn), mode: '包含函数' }) : this.preview.definition({ ...source, range: word }, mode === 'type'));
      }
    }
    if (this.config('autoRelation', true) && !this.relations.locked) {
      const relationSource = this.relationSource(fn, source);
      const key = locationKey(relationSource);
      if (key !== this.session.relationKey) {
        this.session.relationKey = key;
        tasks.push(this.relations.setRoot(relationSource));
      }
    }
    await Promise.all(tasks);
  }
  dispose() { this.disposed = true; clearTimeout(this.followTimer); this.mainGate.dispose(); this.followGate.dispose(); }
}
module.exports = { FollowController };
