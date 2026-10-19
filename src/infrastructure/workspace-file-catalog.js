'use strict';
const vscode = require('vscode');
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
    this.events = new Observable(); this.cache = new Map(); this.revision = 0;
    this.onDidChange = listener => this.events.subscribe(listener);
    const emit = (kind, uri, extra = {}) => {
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
  roots() { return vscode.workspace.workspaceFolders || []; }
  folder(uri) { return [...this.roots()].sort((a, b) => b.uri.path.length - a.uri.path.length).find(root => relativeUriPath(root.uri, uri) !== undefined); }
  documents() { return vscode.workspace.textDocuments || []; }
  document(uri) { return this.documents().find(value => uriKey(value.uri) === uriKey(uri)); }
  /** @param {{folder?:any, pattern?:string, exclude?:string, limit?:number, cancellation?:any, force?:boolean}} options */
  list({ folder, pattern = '**/*', exclude, limit, cancellation, force = false } = {}) {
    const key = JSON.stringify([folder?.uri.toString(), pattern, exclude, limit]);
    const previous = this.cache.get(key);
    if (!force && !cancellation && previous && previous.expires > Date.now()) return previous.promise;
    const promise = Promise.resolve(vscode.workspace.findFiles(folder ? new vscode.RelativePattern(folder.uri, pattern) : pattern, exclude, limit, cancellation));
    if (!cancellation) {
      const entry = { promise, expires: Date.now() + 30000 }; this.cache.set(key, entry);
      promise.catch(() => { if (this.cache.get(key) === entry) this.cache.delete(key); });
      if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
    }
    return promise;
  }
  dispose() { this.disposables.forEach(value => value.dispose()); this.cache.clear(); this.events.dispose(); }
}
module.exports = { WorkspaceFileCatalog, matchesGlob, expand };
