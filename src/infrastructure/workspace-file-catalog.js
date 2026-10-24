'use strict';
const vscode = require('vscode');
const { createHash } = require('node:crypto');
const { ReadingScope, scopeConfigurationChanged } = require('./reading-scope');
const { Observable } = require('../domain/observable');
const { uriKey, relativeUriPath } = require('../resources');
const { globRegex } = require('../core');
function expand(pattern) {
  const match = pattern.match(/\{([^{}]+)\}/);
  return match ? match[1].split(',').flatMap(part => expand(pattern.replace(match[0], part))) : [pattern];
}
function matchesGlob(path, pattern) { return expand(pattern).some(value => globRegex(value).test(path)); }
class WorkspaceFileCatalog {
  constructor() {
    this.scope = new ReadingScope(); this.scopeEpoch = 0; this.configurationEpoch = 0; this.events = new Observable(); this.cache = new Map(); this.revision = 0;
    this.onDidChange = listener => this.events.subscribe(listener);
    const emit = (kind, uri, extra = {}) => {
      if (uri && !this.accepts(uri)) return;
      if (kind === 'config' && ['clangd', 'C_Cpp', 'files.associations'].some(key => extra.configuration.affectsConfiguration(key)) || kind === 'folders' ||
        uri && /(?:^|\/)(?:\.clangd|compile_commands\.json|compile_flags\.txt|CMake(?:User)?Presets\.json|c_cpp_properties\.json)$/.test(uri.path)) this.configurationEpoch++;
      if (kind === 'folders' || kind === 'config' && scopeConfigurationChanged(extra.configuration)) this.scopeEpoch++;
      if (['create', 'delete', 'folders', 'config'].includes(kind)) { this.revision++; this.cache.clear(); }
      this.events.emit({ kind, uri, ...extra });
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables = [watcher, watcher.onDidCreate(uri => emit('create', uri)), watcher.onDidChange(uri => emit('change', uri)), watcher.onDidDelete(uri => emit('delete', uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => emit('folders')),
      vscode.workspace.onDidChangeConfiguration(configuration => emit('config', undefined, { configuration })),
      vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) emit('edit', event.document.uri, { document: event.document }); })];
    if (vscode.workspace.onDidSaveTextDocument) this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => emit('save', document.uri, { document })));
    if (vscode.workspace.onDidCloseTextDocument) this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => emit('close', document.uri, { document })));
  }
  roots() { return this.scope.roots(); }
  searchRoots() {
    const roots = this.roots();
    return this.scope.restricted() ? [{ uri: vscode.Uri.parse('sourceinsight-reader-scope:/all'), name: '整个工作区', index: -1, all: true }, ...roots] : roots;
  }
  contains(uri, snapshot) { return this.scope.contains(uri, snapshot); }
  accepts(uri) { return this.scope.accepts(uri); }
  scopeKey(snapshot) { return this.scope.key(snapshot); }
  configurationKey(uri) {
    const settings = [this.configurationEpoch, vscode.workspace.getConfiguration('clangd').get('arguments', []),
      vscode.workspace.getConfiguration('files').get('associations', {}),
      vscode.workspace.getConfiguration('C_Cpp', uri).get('default.configurationProvider', ''),
      vscode.workspace.getConfiguration('C_Cpp', uri).get('default.compileCommands', '')];
    return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  }
  projectKey(uri, snapshot) {
    return this.folder(uri)?.uri.toString();
  }
  folder(uri) { return [...this.roots()].sort((a, b) => b.uri.path.length - a.uri.path.length).find(root => relativeUriPath(root.uri, uri) !== undefined); }
  documents() { return vscode.workspace.textDocuments || []; }
  document(uri) { return this.documents().find(value => uriKey(value.uri) === uriKey(uri)); }
  /** @param {{folder?:any, pattern?:string, exclude?:string, limit?:number, cancellation?:any, force?:boolean}} options */
  list({ folder, pattern = '**/*', exclude, limit, cancellation, force = false } = {}) {
    const key = JSON.stringify([this.scopeKey(), folder?.uri.toString(), pattern, exclude, limit]);
    const previous = this.cache.get(key);
    if (!force && !cancellation && previous && previous.expires > Date.now()) return previous.promise;
    const promise = this.find({ folder, pattern, exclude, limit, cancellation });
    if (!cancellation) {
      const entry = { promise, expires: Date.now() + 30000 }; this.cache.set(key, entry);
      promise.catch(() => { if (this.cache.get(key) === entry) this.cache.delete(key); });
      if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
    }
    return promise;
  }
  async find({ folder, pattern, exclude, limit, cancellation }) {
    if (!this.scope.restricted()) return vscode.workspace.findFiles(folder ? new vscode.RelativePattern(folder.uri, pattern) : pattern, exclude, limit, cancellation);
    const snapshot = this.scope.snapshot();
    if (snapshot.error) throw new Error(snapshot.error);
    const epoch = this.scopeEpoch;
    const roots = snapshot.roots.flatMap(root => {
      if (!folder || relativeUriPath(folder.uri, root.uri) !== undefined) return [root];
      return relativeUriPath(root.uri, folder.uri) !== undefined && this.contains(folder.uri) ? [folder] : [];
    });
    const results = new Map();
    for (const root of roots) {
      if (cancellation?.isCancellationRequested || epoch !== this.scopeEpoch) return [];
      if (vscode.workspace.fs.stat) {
        const info = await Promise.resolve(vscode.workspace.fs.stat(root.uri)).catch(() => undefined);
        if (!info || !(info.type & vscode.FileType.Directory)) throw new Error(`检索目录不存在或不是文件夹：${root.uri.path}`);
      }
      if (cancellation?.isCancellationRequested || epoch !== this.scopeEpoch) return [];
      const remaining = limit === undefined ? undefined : limit - results.size;
      if (remaining !== undefined && remaining <= 0) break;
      const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root.uri, pattern), this.scope.excludePattern(root, exclude), remaining, cancellation);
      if (epoch !== this.scopeEpoch) return [];
      for (const uri of files) if (this.contains(uri, snapshot)) results.set(uriKey(uri), uri);
    }
    return [...results.values()];
  }
  dispose() { this.disposables.forEach(value => value.dispose()); this.cache.clear(); this.events.dispose(); }
}
module.exports = { WorkspaceFileCatalog, matchesGlob, expand };
