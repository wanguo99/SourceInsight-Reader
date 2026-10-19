'use strict';
const vscode = require('vscode');

// Reuse both result renderers in one independently movable bottom-panel view.
class SearchResultsView {
  constructor(extensionUri, fail) {
    this.extensionUri = extensionUri; this.fail = fail; this.panels = new Map();
  }
  createPanel(mode) {
    if (this.panels.has(mode)) { this.show(mode); return this.panels.get(mode); }
    const messages = new vscode.EventEmitter(), disposed = new vscode.EventEmitter();
    const host = this;
    const panel = { title: '', html: '', reveal() { host.show(mode); }, onDidDispose: disposed.event,
      dispose() { messages.dispose(); disposed.fire(undefined); disposed.dispose(); host.panels.delete(mode); },
      webview: {
        get cspSource() { return host.view?.webview.cspSource || 'vscode-webview:'; },
        asWebviewUri(uri) { return host.view?.webview.asWebviewUri(uri) || uri; },
        onDidReceiveMessage: messages.event,
        postMessage(state) { return host.mode === mode && host.view ? host.view.webview.postMessage(state) : Promise.resolve(false); },
        set html(value) { panel.html = value; if (host.mode === mode) host.render(); }
      }, messages };
    this.panels.set(mode, panel); this.show(mode); return panel;
  }
  show(mode) {
    const changed = this.mode !== mode; this.mode = mode;
    if (changed) this.render();
    this.view?.show?.(true);
    vscode.commands.executeCommand('sourceInsightInspired.searchResults.focus').then(undefined, this.fail);
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const messages = view.webview.onDidReceiveMessage(message => {
      if (message?.action === 'switchResults') {
        const command = message.mode === 'references' ? 'focusReferences' : message.mode === 'text' ? 'focusTextLookup' : undefined;
        if (command) vscode.commands.executeCommand(`sourceInsightInspired.${command}`).then(undefined, this.fail);
      } else this.panels.get(this.mode)?.messages.fire(message);
    });
    const closed = view.onDidDispose(() => { messages.dispose(); closed.dispose(); if (this.view === view) this.view = undefined; });
    // Asset URIs must be generated from the resolved webview, never from a file URI.
    const mode = this.mode;
    this.mode = undefined;
    if (mode) vscode.commands.executeCommand(`sourceInsightInspired.${mode === 'text' ? 'focusTextLookup' : 'focusReferences'}`).then(undefined, this.fail);
    else vscode.commands.executeCommand('sourceInsightInspired.focusTextLookup').then(undefined, this.fail);
  }
  render() {
    const panel = this.panels.get(this.mode);
    if (!this.view || !panel?.html) return;
    const nonce = panel.html.match(/script nonce="([^"]+)"/)?.[1];
    const script = this.view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/search-results.js'));
    this.view.webview.html = panel.html.replace('<body>', `<body><header aria-label="检索类型"><button id="lookupTextTab" aria-pressed="${this.mode === 'text'}">字符检索</button><button id="lookupReferencesTab" aria-pressed="${this.mode === 'references'}">引用检索</button></header>`)
      .replace('</body>', `<script nonce="${nonce}" src="${script}"></script></body>`);
  }
  dispose() { for (const panel of [...this.panels.values()]) panel.dispose(); }
}
module.exports = { SearchResultsView };
