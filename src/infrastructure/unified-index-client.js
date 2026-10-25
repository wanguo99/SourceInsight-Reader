'use strict';
const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { indexStorageDirectory } = require('./index-storage-path');
const { projectResults } = require('./project-boundary');

function serialize(value) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value !== 'object') return value;
  if (typeof value.scheme === 'string' && typeof value.toString === 'function') return { $uri: value.toString() };
  if (value.start && value.end && typeof value.start.line === 'number') return { start: { line: value.start.line, character: value.start.character }, end: { line: value.end.line, character: value.end.character } };
  if (typeof value.line === 'number' && typeof value.character === 'number') return { line: value.line, character: value.character };
  const result = {}; for (const [key, item] of Object.entries(value)) if (typeof item !== 'function') result[key] = serialize(item); return result;
}
function deserialize(value) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value.$uri) return vscode.Uri.parse(value.$uri);
  if (Array.isArray(value)) return value.map(deserialize);
  const result = {}; for (const [key, item] of Object.entries(value)) result[key] = deserialize(item);
  if (result.start && result.end && typeof result.start.line === 'number') return new vscode.Range(result.start.line, result.start.character, result.end.line, result.end.character);
  return result;
}
class UnifiedIndexClient {
  constructor(context, catalog, log = message => {}) {
    this.context = context; this.catalog = catalog; this.log = log; this.pending = new Map(); this.sequence = 0; this.sourceEpoch = 0;
    this.subscription = catalog.onDidChange?.(event => {
      if (['config', 'folders', 'edit', 'save'].includes(event.kind) || event.uri && /\.(?:c|h|cc|cpp|cxx|hpp|hh|hxx|py|pyi|java|js|jsx|ts|tsx|rs|go|cs)$|(?:\.clangd|compile_commands\.json|compile_flags\.txt)$/.test(event.uri.path)) this.sourceEpoch++;
    });
  }
  descriptor(uri, kind, queryKey = '') {
    const document = this.catalog.document(uri), root = this.catalog.folder(uri);
    if (this.disposed || !document || document.isDirty || uri.scheme !== 'file' || !root || !this.catalog.accepts(uri)) return undefined;
    const directory = indexStorageDirectory(this.context, vscode.workspace.getConfiguration('sourceInsightReader').get('indexCacheDirectory', ''));
    if (!directory) return undefined;
    const configuration = JSON.stringify([vscode.workspace.getConfiguration('clangd').get('arguments', []),
      vscode.workspace.getConfiguration('files').get('associations', {}), vscode.workspace.getConfiguration('C_Cpp', uri).get('default.compileCommands', ''),
      vscode.workspace.getConfiguration('C_Cpp', uri).get('default.configurationProvider', ''), this.catalog.scopeKey?.()]);
    const arguments_ = vscode.workspace.getConfiguration('clangd').get('arguments', []), buildFiles = [];
    for (let i = 0; i < arguments_.length; i++) {
      const match = /^--?compile-commands-dir(?:=(.*))?$/.exec(arguments_[i]);
      if (match) buildFiles.push(path.join(match[1] || arguments_[i + 1] || root.uri.fsPath, 'compile_commands.json'));
    }
    const compileCommands = vscode.workspace.getConfiguration('C_Cpp', uri).get('default.compileCommands', '');
    if (typeof compileCommands === 'string' && compileCommands) buildFiles.push(compileCommands);
    return { directory, project: root.uri.toString(), root: root.uri.fsPath, configuration, buildFiles: buildFiles.map(file => file.replace(/\$\{workspaceFolder\}/g, root.uri.fsPath)), version: document.version, generation: this.catalog.configurationKey?.(uri), revision: this.catalog.revision, sourceEpoch: this.sourceEpoch,
      snapshot: { uri: uri.toString(), kind, queryKey, hash: crypto.createHash('sha256').update(document.getText()).digest('hex'), quality: 'semantic' } };
  }
  current(request) { const doc = this.catalog.document(vscode.Uri.parse(request.snapshot.uri)); return doc && !doc.isDirty && doc.version === request.version && this.catalog.accepts(doc.uri) &&
    this.catalog.configurationKey?.(doc.uri) === request.generation && this.catalog.revision === request.revision && this.sourceEpoch === request.sourceEpoch; }
  request(action, descriptor) {
    if (this.disposed) return Promise.resolve(undefined);
    if (!this.worker) {
      const worker = new Worker(path.join(__dirname, '../database-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 128 } }); this.worker = worker; worker.unref();
      worker.on('message', message => { const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); clearTimeout(pending.timer); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); });
      const fail = error => { if (this.worker !== worker) return; this.worker = undefined; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); };
      worker.on('error', fail); worker.on('exit', code => fail(new Error(`索引数据库 Worker 已退出 (${code})`)));
    }
    if (this.pending.size >= 32) return Promise.resolve(undefined);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('索引数据库请求超时')); }, 5000);
      this.pending.set(id, { resolve, reject, timer }); this.worker.postMessage({ id, action, ...descriptor }); });
  }
  publish(request, data) {
    if (!request || !this.current(request) || data === undefined) return Promise.resolve(undefined);
    if (request.snapshot.kind === 'symbols' && !data?.length) return Promise.resolve(undefined);
    return this.request('publish', { ...request, snapshot: { ...request.snapshot, data: serialize(projectResults(this.catalog, request.snapshot.uri, data)) } }).catch(error => { this.log(`语言服务索引保存失败：${error.message}`); });
  }
  async read(request) {
    if (!request || !this.current(request)) return undefined;
    try { const value = await this.request('read', request); return this.current(request) && value ? projectResults(this.catalog, request.snapshot.uri, deserialize(value.data)) : undefined; }
    catch (error) { this.log(`语言服务索引读取失败：${error.message}`); return undefined; }
  }
  async observe(kind, uri, query, action) {
    let request; try { request = this.descriptor(uri, kind, query); } catch (error) { this.log(error.message); }
    const data = await action(); void this.publish(request, data); return data;
  }
  dispose() {
    this.disposed = true; this.subscription?.dispose(); const worker = this.worker; this.worker = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(undefined); } this.pending.clear();
    if (worker) { worker.postMessage({ id: ++this.sequence, action: 'close' }); const timer = setTimeout(() => { void worker.terminate(); }, 2000); timer.unref(); worker.once('exit', () => clearTimeout(timer)); }
  }
}
module.exports = { UnifiedIndexClient, serialize, deserialize };
