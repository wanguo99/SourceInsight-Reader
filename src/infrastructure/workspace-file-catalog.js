'use strict';
const vscode = require('vscode');
const { createHash } = require('node:crypto');
const { ReadingScope, scopeConfigurationChanged } = require('./reading-scope');
const { Observable } = require('../domain/observable');
const { uriKey, relativeUriPath } = require('../resources');
const { globRegex } = require('../core');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { resourcePlan } = require('./index-resources');
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
  async prepareIndex() {
    const selection = this.scope.selection();
    if (selection.mode !== 'compilation') return;
    if (typeof selection.compilationDatabase !== 'string' || !selection.compilationDatabase.startsWith('file:')) throw new Error('请先选择 compile_commands.json');
    if (this.compilationWorker) throw new Error('正在读取编译数据库，请等待完成');
    const config = vscode.workspace.getConfiguration('sourceInsightReader');
    const budget = resourcePlan({ memoryMb: config.get('indexMemoryLimitMb', 1024), memoryMode: config.get('indexMemoryMode', 'fixed'), memoryPercent: config.get('indexMemoryAvailablePercent', 25), cpuPercent: config.get('indexCpuLimitPercent', 25) });
    if (budget.lowMemory) throw new Error('当前可用内存不足，暂不读取编译数据库');
    const encodingSettings = () => this.scope.workspaceRoots().filter(root => root.uri.scheme === 'file').map(root => ({ root: root.uri.fsPath, encoding: vscode.workspace.getConfiguration('files', root.uri).get('encoding', 'utf8') }));
    const encodings = encodingSettings();
    const worker = this.compilationWorker = new Worker(path.join(__dirname, '../compilation-worker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: Math.min(512, budget.coordinatorMb) }, workerData: { memoryMb: Math.min(512, budget.coordinatorMb), cpuFraction: Math.min(1, budget.cpus * budget.cpuPercent / 100), database: selection.compilationDatabase, encodings, pathMappings: selection.pathMappings, roots: this.scope.workspaceRoots().filter(root => root.uri.scheme === 'file').map(root => root.uri.fsPath) }
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { void worker.terminate(); reject(new Error('编译数据库依赖发现超时，请缩小范围')); }, 180000);
        worker.once('message', message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.result); });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', () => { clearTimeout(timer); reject(new Error('编译数据库读取线程已退出')); });
      });
      if (JSON.stringify(selection) !== JSON.stringify(this.scope.selection())) throw new Error('索引模式已改变，请重新开始');
      if (JSON.stringify(encodings) !== JSON.stringify(encodingSettings())) throw new Error('文件编码配置已改变，请重新开始');
      result.selectionKey = JSON.stringify(selection);
      result.fingerprint = createHash('sha256').update(JSON.stringify(result.files)).digest('hex');
      this.scope.compilation = result; this.cache.clear(); this.scopeEpoch++; this.revision++;
      this.events.emit({ kind: 'config', configuration: { affectsConfiguration: key => key === 'sourceInsightReader.projectSources' } });
      return result;
    } finally { await worker.terminate(); this.compilationWorker = undefined; }
  }
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
    const project = this.folder(uri, snapshot)?.uri.toString();
    const scope = snapshot || this.scope.snapshot();
    if (!project || !scope.selected) return project;
    const value = new URL(project); value.searchParams.set('readerScope', this.scope.key(scope)); return value.toString();
  }
  folder(uri, snapshot) { return [...(snapshot ? snapshot.roots : this.roots())].sort((a, b) => b.uri.path.length - a.uri.path.length).find(root => relativeUriPath(root.uri, uri) !== undefined); }
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
    const roots = (snapshot.selected ? snapshot.includedDirectories : snapshot.roots).filter(root => this.contains(root.uri, snapshot)).flatMap(root => {
      if (!folder || relativeUriPath(folder.uri, root.uri) !== undefined) return [root];
      return relativeUriPath(root.uri, folder.uri) !== undefined && this.contains(folder.uri) ? [folder] : [];
    });
    const results = new Map();
    let processed = 0;
    for (const file of snapshot.includedFiles) {
      if (++processed % 128 === 0) await new Promise(resolve => setImmediate(resolve));
      if (cancellation?.isCancellationRequested || epoch !== this.scopeEpoch) return [];
      if (!this.contains(file.uri, snapshot) || folder && relativeUriPath(folder.uri, file.uri) === undefined) continue;
      const relative = relativeUriPath(this.folder(file.uri, snapshot).uri, file.uri);
      if (!matchesGlob(relative, pattern) || exclude && matchesGlob(relative, exclude)) continue;
      // The compilation Worker already checked these files and their realpaths.
      // Avoid thousands of redundant remote fs RPCs before the parser reads them.
      const info = snapshot.compilationValidated ? { type: vscode.FileType.File }
        : await Promise.resolve(vscode.workspace.fs.stat(file.uri)).catch(() => undefined);
      if (epoch !== this.scopeEpoch || cancellation?.isCancellationRequested) return [];
      if (!info || !(info.type & vscode.FileType.File)) continue;
      if (limit !== undefined && results.size >= limit) break;
      results.set(uriKey(file.uri), file.uri);
    }
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
  dispose() { if (this.compilationWorker) void this.compilationWorker.terminate(); this.disposables.forEach(value => value.dispose()); this.cache.clear(); this.events.dispose(); }
}
module.exports = { WorkspaceFileCatalog, matchesGlob, expand };
