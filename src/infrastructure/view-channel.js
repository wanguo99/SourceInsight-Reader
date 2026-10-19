'use strict';
const crypto = require('node:crypto');
const vscode = require('vscode');
const protocol = require('../../shared/protocol');
function escape(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
class ViewChannel {
  constructor(webview, extensionUri, allowed, receive, fail) {
    this.webview = webview; this.extensionUri = extensionUri; this.allowed = allowed; this.session = crypto.randomBytes(16).toString('hex');
    this.sent = 0; this.received = 0;
    this.subscription = webview.onDidReceiveMessage(message => {
      if (!protocol.valid(message, this.session, 'action') || message.sequence <= this.received || !protocol.action(message.payload, allowed)) return;
      this.received = message.sequence; Promise.resolve().then(() => receive(message.payload)).catch(fail);
    });
  }
  roots(extra = []) { return [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'shared'), ...extra]; }
  asset(file) { return this.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, file)); }
  document({ title, body, styles, scripts, iconStyle = false, images = false, fonts = false }) {
    const nonce = crypto.randomBytes(16).toString('hex'), source = this.webview.cspSource;
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="reader-session" content="${this.session}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${source} 'nonce-${nonce}'; script-src 'nonce-${nonce}';${images ? ` img-src ${source};` : ''}${fonts ? ` font-src ${source};` : ''}">
<title>${escape(title)}</title>${styles.map(file => `<link rel="stylesheet" href="${escape(this.asset(file))}">`).join('')}${iconStyle ? `<style id="icon-theme" nonce="${nonce}"></style>` : ''}</head><body>${body}
${['shared/protocol.js', 'media/bridge.js', ...scripts].map(file => `<script nonce="${nonce}" src="${escape(this.asset(file))}"></script>`).join('')}</body></html>`;
  }
  postMessage(payload) { return this.disposed ? Promise.resolve(false) : this.webview.postMessage(protocol.envelope(this.session, ++this.sent, 'state', payload)); }
  dispose() { this.disposed = true; this.subscription.dispose(); }
}
module.exports = { ViewChannel };
