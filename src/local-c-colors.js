'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const vscode = require('vscode');
const { THEME_ID, effectiveTheme } = require('./theme');
const { scopedSettings } = require('./editor-color-settings');
const { isCppHeader } = require('./infrastructure/source-text');
const MAX_SOURCE = 2 * 1024 * 1024;

function semanticColoringEnabled(document) {
  const config = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: document.languageId });
  const enabled = config.get('semanticHighlighting.enabled', /** @type {string | boolean} */ ('configuredByTheme'));
  const custom = vscode.workspace.getConfiguration('editor').get('semanticTokenColorCustomizations', {});
  return enabled !== false && (enabled !== 'configuredByTheme' || scopedSettings(custom).reduce((value, layer) => layer.enabled ?? value, true) !== false);
}

class LocalCColors {
  constructor(log = message => {}) { this.log = log; this.cache = new Map(); this.failed = new WeakMap(); this.headerKinds = new WeakMap(); this.pending = new Map(); this.sequence = 0; this.queue = []; }
  disabledReason(document) {
    if (this.disposed || document.isClosed) return 'document closed';
    if (document.languageId !== 'c') {
      if (document.languageId !== 'cpp' || !/\.h$/i.test(document.uri.path)) return `language=${document.languageId}`;
      let header = this.headerKinds.get(document);
      if (header?.version !== document.version) {
        header = { version: document.version, cpp: isCppHeader(document.getText(), document.uri.path) }; this.headerKinds.set(document, header);
      }
      if (header.cpp) return 'C++ header requires its language service';
    }
    const theme = effectiveTheme(vscode.workspace.getConfiguration('workbench').get('colorTheme'));
    if (theme !== THEME_ID) return `theme=${theme}`;
    if (!semanticColoringEnabled(document)) return 'semantic highlighting disabled by settings';
    return '';
  }
  enabled(document) { return !this.disabledReason(document); }
  colorize(document) {
    if (!this.enabled(document)) return Promise.resolve([]);
    const failure = this.failed.get(document);
    if (failure?.version === document.version && Date.now() < failure.retryAt) return Promise.resolve([]);
    const cached = this.cache.get(document);
    if (cached?.version === document.version) return cached.promise;
    // At most one running request and two waiting documents, even while typing.
    if (Date.now() < (this.cooldown || 0)) return Promise.resolve([]);
    const text = document.getText();
    if (text.length > MAX_SOURCE || Buffer.byteLength(text, 'utf8') > MAX_SOURCE) return Promise.resolve([]);
    for (const queued of this.queue.filter(item => item.document === document)) queued.resolve([]);
    this.queue = this.queue.filter(item => item.document !== document);
    if (this.queue.length >= 2) { const discarded = this.queue.shift(); this.cache.delete(discarded.document); discarded.resolve([]); }
    const version = document.version;
    const promise = new Promise(resolve => this.queue.push({ document, version, text, resolve }));
    this.cache.set(document, { version, promise });
    while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    this.drain();
    return promise;
  }
  drain() {
    if (this.disposed || this.pending.size || !this.queue.length) return;
    clearTimeout(this.idle);
    if (!this.worker) {
      const worker = this.worker = new Worker(path.join(__dirname, 'c-color-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 128 } });
      worker.unref();
      worker.on('message', message => {
        if (this.worker !== worker) return;
        const request = this.pending.get(message.id); if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error) this.fail(request, message.error);
        else this.failed.delete(request.document);
        request.resolve(!message.error && !request.document.isClosed && request.document.version === request.version ? message.spans : []);
        this.drain();
        if (!this.pending.size) { this.idle = setTimeout(() => this.stop(), 30000); this.idle.unref?.(); }
      });
      worker.on('error', error => { if (this.worker === worker) this.stop(true, error.message); });
      worker.on('exit', () => { if (this.worker === worker) this.stop(true); });
    }
    const request = this.queue.shift(), id = ++this.sequence;
    if (request.document.isClosed || request.document.version !== request.version) { request.resolve([]); this.drain(); return; }
    request.timer = setTimeout(() => this.stop(true, '着色线程响应超时（3000ms）'), 3000);
    this.pending.set(id, request);
    this.worker.postMessage({ id, text: request.text });
  }
  fail(request, reason) {
    const previous = this.failed.get(request.document);
    const attempts = previous?.version === request.version ? previous.attempts + 1 : 1;
    const delay = Math.min(60000, 5000 * 2 ** (attempts - 1));
    this.failed.set(request.document, { version: request.version, attempts, retryAt: Date.now() + delay });
    this.cache.delete(request.document);
    this.log(`[C colors] ${request.document.uri.toString()}: ${reason}；${delay / 1000}s 后允许重试`);
  }
  stop(failed = false, reason = '着色线程异常退出') {
    clearTimeout(this.idle);
    const worker = this.worker; this.worker = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); if (failed) this.fail(request, reason); request.resolve([]);
    }
    for (const request of this.queue) { this.cache.delete(request.document); request.resolve([]); }
    this.pending.clear(); this.queue = [];
    if (failed) { this.cache.clear(); this.cooldown = Date.now() + 5000; }
    worker?.terminate();
  }
  dispose() { this.disposed = true; this.stop(); this.cache.clear(); }
}
module.exports = { LocalCColors, semanticColoringEnabled, MAX_SOURCE };
