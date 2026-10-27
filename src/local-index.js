'use strict';
const { indexStatus, failureKind } = require('./domain/index-diagnostics');
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Worker } = require('node:worker_threads');
const { uriKey, relativeUriPath } = require('./resources');
const { scopeConfigurationChanged } = require('./infrastructure/reading-scope');
const { matchesGlob } = require('./infrastructure/workspace-file-catalog');
const { isCppHeader } = require('./infrastructure/source-text');
const { indexMessage } = require('./domain/boundary');
const { cacheStorageDirectory } = require('./infrastructure/index-storage-path');
const { resourcePlan, canResumeBudget } = require('./infrastructure/index-resources');
const { releaseWorkerLeases } = require('./infrastructure/cache-lease');
const { literalIncludeAt } = require('./infrastructure/include-paths');

const REQUEST_TIMEOUT_MS = 60000;
const SCAN_FILE_TIMEOUT_MS = 1000;
// Node timers overflow above this delay and would fire almost immediately.
const MAX_TIMEOUT_MS = 2147483647;


// Extension-host facade; parsing, relation resolution and persistence stay off
// the UI thread. The first cache format is a versioned JSON facts snapshot.
class LocalIndex {
  constructor(context, catalog, log = message => {}, options = {}) {
    this.manualStart = Boolean(options.manualStart); this.sessionStarted = !options.manualStart;
    this.catalog = catalog; this.context = context; this.log = log; this.sequence = 0; this.pending = new Map(); this.refreshSequence = 0;
    this.disposables = []; this.timers = new Map(); this.disposed = false; this.lifecycle = 0;
    this.fileEvents = new Map(); this.batchActive = false;
    this.documentVersions = new Map(); this.dirtyOverlays = new Map(); this.revision = 0; this.phase = 'idle'; this.coverage = new Set();
    this.semanticQueries = new Map(); this.symbolNotes = new Map();
    this.headerKinds = new WeakMap();
    this.exclude = vscode.workspace.getConfiguration('sourceInsightReader').get('indexExclude', '**/{.git,.cache,node_modules,build,dist,out,research}/**');
    this.statusEmitter = new vscode.EventEmitter(); this.onDidChangeStatus = this.statusEmitter.event;
    this.emitter = new vscode.EventEmitter(); this.onDidChange = this.emitter.event;
    this.status = '本地 C 索引尚未建立'; this.operation = 'creating'; this.activeUpdates = 0; this.activeScans = 0;
  }
  getStatus() {
    if (!vscode.workspace.getConfiguration('sourceInsightReader').get('indexEnabled', true)) return { scope: 'index', phase: 'disabled', operation: this.operation, message: '本地 C 索引已关闭', busy: false };
    if (!this.sessionStarted) return { scope: 'index', phase: this.preparing ? 'building' : 'idle', operation: 'creating', message: this.preparing ? '正在读取索引范围与编译数据库…' : '索引尚未启动，请点击“开始索引”选择模式', busy: Boolean(this.preparing) };
    if (!this.enabled()) return { scope: 'index', phase: 'disabled', operation: this.operation, message: '本地 C 索引已关闭', busy: false };
    return { scope: 'index', phase: this.phase, operation: this.operation, message: this.status + (this.catalog.scope?.restricted() ? ' · ' + this.catalog.scope.description() : ''),
      busy: this.phase !== 'error' && (this.phase === 'building' || this.timers.size > 0 || this.fileEvents.size > 0 || this.batchActive || this.activeUpdates > 0 || this.activeScans > 0) };
  }
  beginUpdate() {
    this.operation = this.summary ? 'updating' : 'creating';
    this.phase = 'building';
    this.status = this.recoveringCache ? '复用缓存恢复中…' : this.operation === 'creating' ? '索引创建中…' : '索引更新中…';
    this.statusEmitter.fire(this.status);
  }
  async updateRequest(action, data) {
    const worker = this.worker;
    this.activeUpdates++; this.beginUpdate();
    try { return await this.request(action, data); }
    catch (error) {
      if (this.worker === worker) { this.phase = 'error'; this.status = `索引更新失败：${error.message}`; this.statusEmitter.fire(this.status); } throw error;
    } finally { this.activeUpdates--; }
  }
  enabled() { return this.sessionStarted && vscode.workspace.getConfiguration('sourceInsightReader').get('indexEnabled', true); }
  async startSession() {
    if (this.preparing) throw new Error('正在准备索引，请等待完成');
    if (!vscode.workspace.getConfiguration('sourceInsightReader').get('indexEnabled', true)) throw new Error('请先在设置中启用本地 C 索引');
    this.preparing = true; this.sessionStarted = false; this.statusEmitter.fire(this.getStatus().message);
    try {
      if (this.worker) await this.stopWorker(new Error('重新选择索引范围，停止旧索引任务'));
      const compilation = await this.catalog.prepareIndex?.();
      if (compilation) this.log(JSON.stringify({ event: 'compilationSources', sources: compilation.sources, mappedSources: compilation.mappedSources, missingSources: compilation.missingSources, missingSourceFiles: compilation.missingSourceFiles, unsupported: compilation.unsupported, files: compilation.files.length, outside: compilation.outside, invalid: compilation.invalid, missing: compilation.missing }));
      if (this.disposed) return;
      this.sessionStarted = true;
    } finally { this.preparing = false; this.statusEmitter.fire(this.getStatus().message); }
    await this.refresh(false);
  }
  memoryLimitMb() { const value = vscode.workspace.getConfiguration('sourceInsightReader').get('indexMemoryLimitMb', 1024); return Number.isInteger(value) && value >= 128 && value <= 8192 ? value : 1024; }
  semanticKey(uri, position) { return `${uriKey(uri)}:${position.line}:${position.character}`; }
  isSemanticQuery(uri, position) { return this.semanticQueries.has(this.semanticKey(uri, position)); }
  beginSemanticQuery(uri, position) {
    const key = this.semanticKey(uri, position); this.semanticQueries.set(key, (this.semanticQueries.get(key) || 0) + 1);
    return { dispose: () => {
      const count = (this.semanticQueries.get(key) || 0) - 1;
      if (count > 0) this.semanticQueries.set(key, count); else this.semanticQueries.delete(key);
    } };
  }
  supportsHeader(uri) {
    if (!/\.h$/i.test(uri.path)) return true;
    const associations = vscode.workspace.getConfiguration('files').get('associations', {});
    for (const [pattern, language] of Object.entries(associations)) if (['cpp', 'objective-cpp'].includes(language) &&
      (matchesGlob(uri.path, pattern) || matchesGlob(uri.path.split('/').pop(), pattern))) return false;
    const document = this.catalog.document?.(uri);
    if (!document?.getText) return true;
    const cached = this.headerKinds.get(document);
    if (cached?.version === document.version) return cached.supported;
    const supported = !isCppHeader(document.getText(), uri.path);
    this.headerKinds.set(document, { version: document.version, supported }); return supported;
  }
  isExcluded(uri, pattern, snapshot) {
    const root = this.catalog.folder?.(uri, snapshot) || vscode.workspace.workspaceFolders?.find(folder => relativeUriPath(folder.uri, uri) !== undefined);
    return matchesGlob(root ? relativeUriPath(root.uri, uri) : uri.path, pattern || '');
  }
  supports(uri, scopeSnapshot) { return uri.scheme === 'file' && /\.(?:c|h|cc|cpp|cxx|hpp|hh|hxx)$/i.test(uri.path) && !this.isExcluded(uri, this.exclude, scopeSnapshot) &&
    (this.catalog.contains ? this.catalog.contains(uri, scopeSnapshot) : vscode.workspace.workspaceFolders?.some(folder => relativeUriPath(folder.uri, uri) !== undefined)); }
  describe(uri) {
    if (!this.sessionStarted) return { state: 'notIndexed', note: '索引尚未启动，请点击“开始索引”选择模式' };
    if (!this.enabled()) return { state: 'disabled', note: '本地 C 索引未启用' };
    if (this.catalog.accepts && !this.catalog.accepts(uri)) return { state: 'excluded', note: '当前文件未导入工程、已被屏蔽或不在工作区内；可运行“管理工程文件”调整' };
    if (this.exclude && this.isExcluded(uri, this.exclude)) return { state: 'excluded', note: '文件被 indexExclude 排除' };
    const failure = this.summary?.failures?.find(failure => failure.uri === uri.toString());
    if (failure) return { state: (failure.kind || failureKind(failure.message)) === 'unsupported' ? 'unsupported'
      : (failure.kind || failureKind(failure.message)) === 'budget' ? 'notIndexed' : 'error', note: failure.message };
    if (!this.supports(uri)) return { state: 'unsupported', note: '文件不在本地 C 索引支持的工作区 / 扩展名范围' };
    if (this.summaryScope !== undefined && this.summaryScope !== this.catalog.scopeKey?.()) return { state: 'building', note: '屏蔽规则已改变，正在更新索引' };
    if (this.phase === 'building') return { state: 'building', note: this.status };
    if (this.phase === 'error') return { state: 'error', note: this.status };
    if (this.phase === 'idle') return { state: 'building', note: '本地 C 索引尚未建立，将自动建立' };
    if (!this.coverage.has(uriKey(uri))) return { state: 'notIndexed', note: this.summary?.memoryLimited
      ? '当前文件因内存预算未收录，请缩小范围或调整索引资源预算 后重建' : '当前文件未被本地索引收录' };
    const note = this.symbolNotes?.get(uriKey(uri));
    return { state: 'ready', note: note ? `${this.status} · ${note}` : this.status };
  }
  async issues() {
    if (!this.worker || !this.summary || this.summaryScope !== this.catalog.scopeKey?.()) return [];
    const lifecycle = this.lifecycle, values = await this.request('issues');
    return lifecycle === this.lifecycle ? values.filter(value => typeof value.uri === 'string' && this.catalog.accepts(vscode.Uri.parse(value.uri))) : [];
  }
  request(action, data = {}) {
    if (this.disposed || !this.worker) return Promise.reject(new Error('本地索引已停止'));
    const id = ++this.sequence;
    const fileCount = action === 'scan' ? data.files.length : 0;
    const timeout = Math.min((REQUEST_TIMEOUT_MS + fileCount * SCAN_FILE_TIMEOUT_MS) / (action === 'scan' ? this.workerCpuCapacity || 1 : 1), MAX_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      let stallTimer;
      const expire = message => {
        this.pending.delete(id);
        clearTimeout(timer); clearTimeout(stallTimer); reject(new Error(message));
      };
      const timer = setTimeout(() => expire(action === 'scan'
          ? `本地 C 索引扫描超时（${fileCount} 个文件，等待上限 ${Math.ceil(timeout / 1000)} 秒），请重建索引`
          : '本地索引查询超时，请刷新 Relation'), timeout);
      const touch = action === 'scan' ? () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => expire('本地 C 索引扫描超时（60 秒没有文件进度），请检查失败文件并重建索引'), 60000);
      } : undefined;
      const clear = () => { clearTimeout(timer); clearTimeout(stallTimer); };
      this.pending.set(id, { resolve, reject, timer, touch, clear });
      if (this.workerOnline) touch?.();
      try { this.worker.postMessage({ id, action, ...data }); } catch (error) {
        this.pending.delete(id); clear(); reject(error);
      }
    });
  }
  stopWorker(error) {
    clearInterval(this.sharedTimer);
    this.lifecycle++;
    clearTimeout(this.batchTimer); this.batchTimer = undefined;
    for (const entry of this.fileEvents.values()) for (const waiter of entry.waiters) waiter.reject(error); this.fileEvents.clear();
    for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
    for (const pending of this.pending.values()) { pending.clear(); pending.reject(error); }
    this.pending.clear(); this.ready = undefined; this.summary = undefined; this.coverage.clear();
    this.symbolNotes?.clear();
    this.documentVersions.clear(); this.dirtyOverlays.clear();
    this.resolveFirstSnapshot?.(false); this.resolveFirstSnapshot = undefined;
    this.firstSnapshot = undefined; this.firstSnapshotScope = undefined; this.firstSnapshotExclude = undefined; this.firstSnapshotPending = false;
    const worker = this.worker, temporary = this.workerTemporary, ownerThread = worker?.threadId, directories = this.workerLeaseDirectories || new Set(); this.worker = undefined; this.workerTemporary = undefined;
    const terminating = Promise.resolve(worker?.terminate()).then(async () => {
      if (ownerThread > 0) await releaseWorkerLeases(directories, ownerThread);
      // A terminated cache writer cannot finish its atomic temporary snapshot.
      // Remove only this thread's owned temporary file, keeping the last cache.
      if (temporary) try { await fs.unlink(temporary); }
      catch (error) { if (error.code !== 'ENOENT') this.log(`索引临时缓存清理失败：${error.message}`); }
      return true;
    }, error => { this.log(`索引线程终止失败：${error.message}`); return false; });
    this.workerStopping = Promise.all([this.workerStopping, terminating]).then(values => values.every(value => value !== false));
    return this.workerStopping;
  }
  fail(error) {
    const oom = error.code === 'ERR_WORKER_OUT_OF_MEMORY' || /heap out of memory|reaching memory limit/i.test(error.message || String(error));
    if (oom) this.memoryFailure = Object.assign(new Error(`本地索引达到线程堆上限（配置总预算 ${this.workerMemoryLimitMb || this.memoryLimitMb()} MiB），已停止自动重试；请缩小索引范围或调整索引资源预算 后手动重建`), { code: 'INDEX_WORKER_MEMORY' });
    this.stopWorker(error);
    this.phase = 'error'; this.revision++;
    this.status = `本地索引不可用：${this.memoryFailure?.message || error.message || error}`; this.log(this.status); this.statusEmitter.fire(this.status); this.emitter.fire(undefined);
  }
  async ensure(force = false, allowPartial = false) {
    if (this.disposed || !this.enabled() || !vscode.workspace.workspaceFolders?.length ||
      typeof vscode.workspace.findFiles !== 'function') return false;
    if (this.memoryFailure) throw this.memoryFailure;
    if (this.worker && this.summary && (allowPartial || !this.activeScans) && (this.summaryExclude === undefined || this.summaryExclude === this.exclude) &&
      (this.summaryScope === undefined || this.summaryScope === this.catalog.scopeKey?.())) return true;
    if (!this.ready) { const lifecycle = this.lifecycle; this.ready = this.start(force).catch(error => { if (this.lifecycle === lifecycle) this.fail(error); throw error; }); }
    await (allowPartial && this.firstSnapshot && this.firstSnapshotScope === this.catalog.scopeKey?.() && this.firstSnapshotExclude === this.exclude ? Promise.race([this.ready, this.firstSnapshot]) : this.ready);
    return Boolean(this.summary) && (this.summaryExclude === undefined || this.summaryExclude === this.exclude) && (this.summaryScope === undefined || this.summaryScope === this.catalog.scopeKey?.());
  }
  async start(force = false, memoryRetry = false) {
    if (this.workerStopping) {
      const lifecycle = this.lifecycle, stopped = await this.workerStopping;
      if (!stopped) throw new Error('旧索引线程尚未退出，无法安全启动索引');
      if (this.disposed || !this.enabled() || lifecycle !== this.lifecycle) return { cancelled: true };
    }
    this.beginUpdate();
    if (!this.firstSnapshotPending || this.firstSnapshotScope !== this.catalog.scopeKey?.() || this.firstSnapshotExclude !== this.exclude) this.prepareFirstSnapshot();
    this.workerOnline = false;
    this.recoveringCache = memoryRetry;
    this.workerMemoryLimitMb = this.memoryLimitMb();
    const plan = resourcePlan({ memoryMb: this.workerMemoryLimitMb, cpuPercent: vscode.workspace.getConfiguration('sourceInsightReader').get('indexCpuLimitPercent', 25),
      memoryMode: vscode.workspace.getConfiguration('sourceInsightReader').get('indexMemoryMode', 'fixed'),
      memoryPercent: vscode.workspace.getConfiguration('sourceInsightReader').get('indexMemoryAvailablePercent', 25) });
    this.workerMemoryLimitMb = plan.memoryMb;
    this.log(JSON.stringify({ event: 'indexResourcePlan', ...plan }));
    this.workerCpuCapacity = Math.min(1, plan.cpuFraction * (plan.parsers + 1));
    this.worker = new Worker(path.join(__dirname, 'index-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: plan.coordinatorMb },
      workerData: { memoryLimitMb: this.workerMemoryLimitMb, resourcePlan: plan, baselineRss: process.memoryUsage.rss() } });
    clearInterval(this.sharedTimer);
    this.sharedTimer = setInterval(() => {
      if (this.disposed || !this.worker || this.sharedPolling || this.activeScans || this.activeUpdates || !this.summary) return;
      this.sharedPolling = true; const lifecycle = this.lifecycle;
      this.request('sharedPoll').then(async result => {
        if (this.disposed || lifecycle !== this.lifecycle) return;
        if (result.refresh) await this.refresh();
        else if (result.summary) { this.summary = result.summary; this.revision++; this.report(); this.emitter.fire(undefined); }
      }).catch(error => { if (!this.disposed) this.log(`共享索引同步延后：${error.message}`); }).finally(() => { this.sharedPolling = false; });
    }, 3000); this.sharedTimer.unref?.();
    const worker = this.worker;
    const ownerThread = worker.threadId, directories = this.workerLeaseDirectories = new Set();
    this.workerTemporary = this.context.storageUri && worker.threadId > 0
      ? `${path.join(this.context.storageUri.fsPath, 'c-index-v2.json')}.${process.pid}.${worker.threadId}.tmp` : undefined;
    this.worker.on('message', message => {
      if (this.worker !== worker) return;
      if (!indexMessage(message)) { this.fail(new Error('索引线程返回无效消息，请重建索引')); return; }
      if (message.diagnostic) { this.log(`索引缓存：${message.diagnostic}`); return; }
      if (message.snapshot) {
        if (message.snapshot.scopeKey !== this.catalog.scopeKey?.() || message.snapshot.indexExclude !== this.exclude) return;
        this.summary = message.snapshot.summary; this.summaryScope = message.snapshot.scopeKey;
        this.summaryExclude = message.snapshot.indexExclude;
        this.coverage = new Set(message.snapshot.uris.map(uri => uriKey(vscode.Uri.parse(uri))));
        this.revision++; this.report(); this.firstSnapshotPending = false; this.resolveFirstSnapshot?.(true); this.emitter.fire(undefined); return;
      }
      if (message.progress) {
        const request = this.pending.get(message.progress.id);
        if (message.progress.id !== undefined && !request) return;
        request?.touch?.();
        this.status = `${message.progress.stage === 'relations' ? '调用关系构建中' : this.recoveringCache ? '复用缓存恢复中' : this.operation === 'creating' ? '索引创建中' : '索引更新中'}… ${message.progress.done}/${message.progress.total} 个文件`; this.statusEmitter.fire(this.status); return;
      }
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); pending.clear();
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    this.worker.on('online', () => {
      if (this.worker !== worker) return;
      this.workerOnline = true;
      for (const pending of this.pending.values()) pending.touch?.();
    });
    this.worker.on('error', error => { if (!this.disposed && this.worker === worker) this.fail(error); });
    this.worker.on('exit', code => {
      void releaseWorkerLeases(directories, ownerThread).catch(error => this.log(`缓存占用标记清理失败：${error.message}`));
      if (!this.disposed && this.worker === worker) this.fail(new Error(`索引进程退出：${code}`));
    });
    if (!this.watching) { this.watching = true; this.watch(); }
    const summary = await this.scan(force);
    if (!summary.cancelled && canResumeBudget(summary, memoryRetry)) {
      this.log('内存压力后释放索引线程，复用已提交缓存补齐未收录文件（最多自动恢复一次）');
      const stopping = this.stopWorker(new Error('索引线程资源整理，正在复用缓存恢复'));
      const lifecycle = this.lifecycle;
      await stopping;
      if (this.disposed || !this.enabled() || lifecycle !== this.lifecycle) return { cancelled: true };
      const retry = this.start(false, true).catch(error => { if (lifecycle === this.lifecycle) this.fail(error); throw error; });
      this.ready = retry; return retry;
    }
    return summary;
  }
  prepareFirstSnapshot() {
    this.resolveFirstSnapshot?.(false);
    this.firstSnapshotScope = this.catalog.scopeKey?.();
    this.firstSnapshotExclude = this.exclude;
    this.firstSnapshotPending = true;
    this.firstSnapshot = new Promise(resolve => { this.resolveFirstSnapshot = resolve; });
  }
  async scan(force = false) {
    this.beginUpdate();
    const lifecycle = this.lifecycle;
    const scopeKey = this.catalog.scopeKey?.();
    const scopeRoots = this.catalog.roots?.().map(root => ({ uri: root.uri.toString(), project: this.catalog.projectKey?.(root.uri) }));
    const exclude = vscode.workspace.getConfiguration('sourceInsightReader').get('indexExclude',
      '**/{.git,.cache,node_modules,build,dist,out,research}/**');
    this.exclude = exclude;
    this.scanCancellation?.dispose();
    const cancellation = new vscode.CancellationTokenSource(); this.scanCancellation = cancellation;
    let uris;
    let enumerationTimer, enumerationExpired = false;
    try { uris = await Promise.race([this.catalog.list({ pattern: '**/*.{c,C,h,H,cc,cpp,cxx,hpp,hh,hxx,CC,CPP,CXX,HPP,HH,HXX}', exclude, force, cancellation: cancellation.token }),
      new Promise((resolve, reject) => { enumerationTimer = setTimeout(() => { enumerationExpired = true; cancellation.cancel(); reject(new Error('工程文件枚举超过 30 秒，请检查远程文件系统或屏蔽范围')); }, 30000); })]); }
    catch (error) { if (!enumerationExpired && (cancellation.token.isCancellationRequested || scopeKey !== this.catalog.scopeKey?.())) return { cancelled: true }; throw error; }
    finally { clearTimeout(enumerationTimer); }
    if (this.disposed || lifecycle !== this.lifecycle || cancellation.token.isCancellationRequested || scopeKey !== this.catalog.scopeKey?.() || exclude !== this.exclude) return { cancelled: true };
    const open = new Map(this.catalog.documents().filter(doc => !doc.isClosed).map(doc => [uriKey(doc.uri), doc]));
    const scopeSnapshot = this.catalog.scope?.snapshot();
    const files = uris.filter(uri => this.supports(uri, scopeSnapshot)).map(uri => {
      const document = open.get(uriKey(uri));
      return { uri: uri.toString(), path: uri.fsPath, project: (this.catalog.projectKey ? this.catalog.projectKey(uri, scopeSnapshot) : this.catalog.folder?.(uri)?.uri.toString()) ||
        vscode.workspace.workspaceFolders?.find(root => relativeUriPath(root.uri, uri) !== undefined)?.uri.toString() || uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) }).toString(), scopeKey, indexExclude: exclude,
        encoding: vscode.workspace.getConfiguration('files', uri).get('encoding', 'utf8'), ...(document?.isDirty ? { text: document.getText(), dirty: true } : {}) };
    });
    const active = vscode.window.activeTextEditor?.document.uri || this.preferredUri;
    files.sort((a, b) => Number(b.uri === active?.toString()) - Number(a.uri === active?.toString()) || Number(open.has(uriKey(vscode.Uri.parse(b.uri)))) - Number(open.has(uriKey(vscode.Uri.parse(a.uri)))));
    const dirtySnapshots = files.filter(file => file.text !== undefined).map(file => {
      const id = uriKey(vscode.Uri.parse(file.uri)), document = open.get(id), token = Symbol();
      this.dirtyOverlays.set(id, token); return { id, document, version: document.version, token };
    });
    this.activeScans++;
    let summary;
    const databaseDirectory = cacheStorageDirectory(this.context, vscode.workspace.getConfiguration('sourceInsightReader').get('cacheDirectory', ''));
    if (databaseDirectory) this.workerLeaseDirectories?.add(databaseDirectory);
    try { summary = await this.request('scan', { files, force, scopeKey, scopeRoots, priorityUris: this.priorityUris(), indexExclude: exclude,
      databaseDirectory,
      cachePath: this.context.storageUri ? path.join(this.context.storageUri.fsPath, 'c-index-v2.json') : undefined }); }
    finally { this.activeScans--; }
    if (summary.cancelled || lifecycle !== this.lifecycle || cancellation.token.isCancellationRequested || scopeKey !== this.catalog.scopeKey?.() || exclude !== this.exclude) return { ...summary, cancelled: true };
    const failed = new Set((summary.failures || []).map(value => uriKey(vscode.Uri.parse(value.uri))));
    this.coverage = new Set((summary.indexedUris || files.map(file => file.uri)).map(uri => uriKey(vscode.Uri.parse(uri))).filter(uri => !failed.has(uri)));
    for (const snapshot of dirtySnapshots) {
      if (this.dirtyOverlays.get(snapshot.id) === snapshot.token && !snapshot.document.isClosed && snapshot.document.version === snapshot.version)
        this.documentVersions.set(snapshot.id, snapshot.version);
    }
    this.summaryScope = scopeKey; this.summaryExclude = exclude; this.summary = summary; this.revision++; this.report(); this.emitter.fire(undefined); return summary;
  }
  report() {
    this.phase = this.timers.size || this.fileEvents.size || this.activeUpdates || this.activeScans ? 'building' : 'ready';
    const summary = this.summary;
    this.status = indexStatus(summary);
    if (this.phase === 'building') this.status = this.recoveringCache ? '复用缓存恢复中…' : this.operation === 'creating' ? '索引创建中…' : '索引更新中…';
    this.log(this.status); this.statusEmitter.fire(this.status);
    if (summary.memoryLimited) this.log(JSON.stringify({ event: 'indexMemory', ...summary.memory, indexedFiles: summary.files, deferredFiles: summary.deferredFiles }));
    for (const error of summary.failures || []) this.log(`${error.uri}: ${error.message}`);
  }
  priorityUris() {
    const active = vscode.window.activeTextEditor?.document.uri || this.preferredUri;
    return [...new Set([active, ...this.catalog.documents().filter(doc => !doc.isClosed).map(doc => doc.uri)]
      .filter(uri => uri && this.supports(uri) && !this.isExcluded(uri, this.exclude || '')).map(uri => uri.toString()))];
  }
  prioritize() {
    if (!this.worker || !this.activeScans || !this.enabled() || this.disposed) return;
    this.request('prioritize', { uris: this.priorityUris(), scopeKey: this.catalog.scopeKey?.(), indexExclude: this.exclude })
      .catch(error => this.log(error.message));
  }
  watch() {
    const active = vscode.window.onDidChangeActiveTextEditor?.(() => this.prioritize());
    const opened = vscode.workspace.onDidOpenTextDocument?.(() => this.prioritize());
    if (active) this.disposables.push(active);
    if (opened) this.disposables.push(opened);
    const schedule = (uri, remove = false) => {
      if (!this.enabled() || !this.supports(uri) || !this.worker || this.isExcluded(uri, this.exclude || '')) return;
      const id = uriKey(uri); clearTimeout(this.timers.get(id)); this.beginUpdate();
      if (remove) { this.documentVersions.delete(id); this.dirtyOverlays.delete(id); }
      this.timers.set(id, setTimeout(async () => {
        const lifecycle = this.lifecycle;
        this.timers.delete(id);
        if (!this.enabled() || !this.supports(uri)) return;
        try {
          await this.ensure(false, true);
          if (!this.supports(uri)) return;
          await this.queueFile(uri, remove);
        } catch (error) { if (lifecycle === this.lifecycle) { this.log(`本地索引更新失败：${error.message}`); this.status = `本地索引更新失败：${error.message}`; this.phase = 'error'; this.statusEmitter.fire(this.status); } }
      }, 350));
    };
    this.disposables.push(this.catalog.onDidChange(event => {
      if (['create', 'close'].includes(event.kind)) this.prioritize();
      if (event.kind === 'folders') { this.refresh().catch(error => this.log(error.message)); return; }
      if (event.kind === 'config') {
        if (this.manualStart && event.configuration.affectsConfiguration('sourceInsightReader.projectSources')) {
          this.sessionStarted = false;
          if (this.worker) void this.stopWorker(new Error('索引模式或工程清单已改变，等待手动开始'));
          this.phase = 'idle'; this.statusEmitter.fire(this.getStatus().message); this.emitter.fire(undefined); return;
        }
        if (event.configuration.affectsConfiguration('sourceInsightReader.indexEnabled') || event.configuration.affectsConfiguration('sourceInsightReader.indexExclude') || event.configuration.affectsConfiguration('sourceInsightReader.indexMemoryLimitMb') || ['indexCpuLimitPercent', 'indexMemoryMode', 'indexMemoryAvailablePercent'].some(key => event.configuration.affectsConfiguration('sourceInsightReader.' + key)) || event.configuration.affectsConfiguration('sourceInsightReader.cacheDirectory') || scopeConfigurationChanged(event.configuration)) {
          if (!this.enabled()) {
            this.scanCancellation?.cancel(); this.refreshSequence++;
            for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear();
            clearTimeout(this.batchTimer);
            for (const entry of this.fileEvents.values()) for (const waiter of entry.waiters) waiter.reject(new Error('本地索引已关闭'));
            this.fileEvents.clear();
            this.stopWorker(new Error('本地索引已关闭')); this.memoryFailure = undefined;
            this.phase = 'idle'; this.revision++; this.statusEmitter.fire(this.status); this.emitter.fire(undefined); return;
          }
          if (event.configuration.affectsConfiguration('sourceInsightReader.indexMemoryLimitMb') || ['indexCpuLimitPercent', 'indexMemoryMode', 'indexMemoryAvailablePercent'].some(key => event.configuration.affectsConfiguration('sourceInsightReader.' + key)) || event.configuration.affectsConfiguration('sourceInsightReader.cacheDirectory')) {
            this.scanCancellation?.cancel(); this.stopWorker(Object.assign(new Error('索引内存配置已变化'), { code: 'cancelled' }));
          }
          this.memoryFailure = undefined;
          if (event.configuration.affectsConfiguration('sourceInsightReader.indexExclude')) this.exclude = vscode.workspace.getConfiguration('sourceInsightReader').get('indexExclude', '**/{.git,.cache,node_modules,build,dist,out,research}/**');
          if (scopeConfigurationChanged(event.configuration) || event.configuration.affectsConfiguration('sourceInsightReader.indexExclude')) {
            this.scanCancellation?.cancel();
            this.request('cancelScan').catch(error => this.log(error.message));
            for (const timer of this.timers.values()) clearTimeout(timer);
            this.timers.clear(); this.documentVersions.clear(); this.dirtyOverlays.clear();
          }
          this.statusEmitter.fire(this.status); this.refresh().catch(error => this.log(error.message)); }
        return;
      }
      if (event.kind === 'close') {
        const id = uriKey(event.uri), hadOverlay = this.dirtyOverlays.delete(id);
        this.documentVersions.delete(id);
        // Read-only previews are opened and closed by VS Code itself. Their
        // lifecycle does not change source facts and must not start index work.
        // A discarded dirty overlay (including an in-flight one) needs one disk restore.
        if (hadOverlay && !this.timers.has(id)) schedule(event.uri);
        return;
      }
      if (event.uri) schedule(event.uri, event.kind === 'delete');
    }));
  }
  async refresh(force = false) {
    this.memoryFailure = undefined;
    if (this.disposed || !this.enabled()) return;
    if (force && this.worker) {
      // Clearing Maps does not immediately reclaim the old facts graph or JSON
      // serialization garbage. Rebuild in a fresh isolate rather than treating
      // that old heap occupancy as the new scan's live memory requirement.
      ++this.refreshSequence; this.ready?.catch(() => {}); this.scanCancellation?.cancel();
      const terminated = this.stopWorker(new Error('本地索引正在重建，旧线程已替换'));
      const lifecycle = this.lifecycle;
      this.prepareFirstSnapshot();
      this.ready = terminated.then(stopped => {
        if (!stopped) throw new Error('旧索引线程尚未退出，无法安全启动重建');
        if (!this.disposed && this.enabled() && lifecycle === this.lifecycle) return this.start(true);
      }).catch(error => { if (lifecycle === this.lifecycle) this.fail(error); throw error; });
      this.beginUpdate(); this.revision++; this.emitter.fire(undefined);
      await this.ready; return;
    }
    // Initial startup already performs a scan; do not scan the entire project twice.
    if (!this.worker) { await this.ensure(force); return; }
    const previous = this.ready, sequence = ++this.refreshSequence, lifecycle = this.lifecycle;
    this.beginUpdate();
    const pending = Promise.resolve(previous).then(() => {
      if (!this.disposed && this.enabled() && sequence === this.refreshSequence) return this.scan(force);
    }).catch(error => { if (this.lifecycle === lifecycle) this.fail(error); throw error; });
    this.ready = pending; await pending;
  }
  convert(item) {
    const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
    return { ...item, uri: vscode.Uri.parse(item.uri), range: range(item.range), selectionRange: range(item.selectionRange),
      ...(item.children ? { children: item.children.map(child => this.convert(child)) } : {}) };
  }
  async prepare(uri, position, name) {
    this.preferredUri = uri;
    if (!this.supports(uri) || !await this.ensure(false, true)) return [];
    await this.syncDocument(uri);
    const query = { uri: uri.toString(), position: { line: position.line, character: position.character }, name };
    const items = await this.request('prepare', query);
    const suffix = this.summary?.failures?.length ? ' · 部分文件未更新，详见输出' : '';
    return items.filter(item => this.supports(vscode.Uri.parse(item.uri))).map(item => this.convert({ ...item, detail: item.detail + suffix }));
  }
  async callDiagnostics(item, direction) {
    return this.request('callDiagnostics', { item: { sourceInsightReaderLocal: item.sourceInsightReaderLocal }, direction });
  }
  async calls(item, direction) {
    if (!await this.ensure(false, true)) return [];
    const calls = await this.request('calls', { item: { sourceInsightReaderLocal: item.sourceInsightReaderLocal }, direction });
    const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
    return calls.filter(call => this.supports(vscode.Uri.parse(direction === 'incoming' ? call.from.uri : call.to.uri))).map(call => direction === 'incoming'
      ? { from: this.convert(call.from), fromRanges: call.fromRanges.map(range) }
      : { to: this.convert(call.to), fromRanges: call.fromRanges.map(range) });
  }
  async definitions(uri, position) {
    this.preferredUri = uri;
    if (!this.supports(uri) || !await this.ensure(false, true)) return [];
    await this.syncDocument(uri);
    const include = literalIncludeAt(this.catalog.document?.(uri), position);
    const query = { uri: uri.toString(), position: { line: position.line, character: position.character }, ...(include ? { include } : {}) };
    const action = include ? 'includeDefinitions' : 'definitions';
    const revision = this.revision;
    let items = await this.request(action, query);
    // A priority-file snapshot may precede its headers. If the scan published
    // newer facts while the query ran, retry once against that revision. Give
    // small scans a bounded grace period without blocking on large projects.
    if (!items.length && this.activeScans && this.ready) {
      let timer;
      try { await Promise.race([this.ready.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 150); })]); }
      finally { clearTimeout(timer); }
    }
    if (!items.length && revision !== this.revision) items = await this.request(action, query);
    return items.filter(item => this.supports(vscode.Uri.parse(item.uri))).map(item => { const value = this.convert(item); return { uri: value.uri, range: value.selectionRange, ...(include ? { includePath: include.name } : {}) }; });
  }
  async explain(uri, position) {
    if (!this.supports(uri) || !await this.ensure(false, true)) return undefined;
    return this.request('explain', { uri: uri.toString(), position: { line: position.line, character: position.character } });
  }
  async references(uri, position) {
    if (!this.enabled() || !this.supports(uri) || !await this.ensure()) return { locations: [] };
    for (const document of this.catalog.documents()) if (document.isDirty && this.supports(document.uri)) await this.syncDocument(document.uri);
    return this.request('references', { uri: uri.toString(), position: { line: position.line, character: position.character } });
  }
  async includeRelations(uri, incoming = false) {
    if (!this.enabled() || !this.supports(uri) || !await this.ensure()) return [];
    const values = await this.request('includeRelations', { uri: uri.toString(), incoming });
    return values.filter(value => this.supports(vscode.Uri.parse(value.uri))).map(value => ({ uri: vscode.Uri.parse(value.uri),
      range: new vscode.Range(value.range.start.line, value.range.start.character, value.range.end.line, value.range.end.character) }));
  }
  async workspaceSymbols(query) {
    if (!await this.ensure()) return [];
    for (const document of this.catalog.documents()) {
      if (!document.isClosed && document.isDirty && this.supports(document.uri)) await this.syncDocument(document.uri);
    }
    const values = await this.request('workspaceSymbols', { query });
    return values.filter(item => this.supports(vscode.Uri.parse(item.uri))).map(item => ({ name: item.name, kind: item.kind, containerName: item.containerName,
      location: { uri: vscode.Uri.parse(item.uri), range: new vscode.Range(item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character) } }));
  }
  async symbols(uri) {
    this.preferredUri = uri;
    if (!this.supports(uri) || !await this.ensure(false, true)) return [];
    if (!this.supports(uri)) return [];
    await this.syncDocument(uri);
    const values = await this.request('symbols', { uri: uri.toString() });
    this.symbolNotes ||= new Map();
    if (values.sourceInsightReaderNote) { if (this.symbolNotes.size >= 128) this.symbolNotes.delete(this.symbolNotes.keys().next().value); this.symbolNotes.set(uriKey(uri), values.sourceInsightReaderNote); }
    else this.symbolNotes.delete(uriKey(uri));
    return values.map(item => this.convert(item));
  }
  async updateFile(uri, remove = false) {
    if (!this.supports(uri)) return;
    const lifecycle = this.lifecycle;
    const id = uriKey(uri), document = this.catalog.documents().find(doc => !doc.isClosed && uriKey(doc.uri) === id);
    const dirty = !remove && Boolean(document?.isDirty), version = dirty ? document.version : undefined;
    const previousOverlay = this.dirtyOverlays.get(id), token = Symbol();
    if (dirty) this.dirtyOverlays.set(id, token);
    const summary = remove ? await this.updateRequest('remove', { uri: uri.toString() })
      : await this.updateRequest('update', { file: { uri: uri.toString(), path: uri.fsPath, project: this.catalog.projectKey ? this.catalog.projectKey(uri) : this.catalog.folder?.(uri)?.uri.toString(),
        scopeKey: this.catalog.scopeKey?.(), indexExclude: this.exclude, encoding: vscode.workspace.getConfiguration('files', uri).get('encoding', 'utf8'),
        ...(dirty ? { text: document.getText() } : {}) }, dirty });
    if (lifecycle !== this.lifecycle || this.disposed) return;
    if (dirty) {
      if (this.dirtyOverlays.get(id) === token && !document.isClosed && document.version === version) this.documentVersions.set(id, version);
    } else if (this.dirtyOverlays.get(id) === previousOverlay) {
      this.dirtyOverlays.delete(id); this.documentVersions.delete(id);
    }
    this.summary = summary;
    if (remove) this.coverage.delete(id); else this.coverage.add(id);
    this.revision++; this.report(); this.emitter.fire(uri);
  }
  queueFile(uri, remove) {
    return new Promise((resolve, reject) => {
      const key = uriKey(uri), previous = this.fileEvents.get(key);
      this.fileEvents.set(key, { uri, remove, waiters: [...(previous?.waiters || []), { resolve, reject }] });
      if (!this.batchTimer && !this.batchActive) this.batchTimer = setTimeout(() => this.flushFiles(), 0);
    });
  }
  async flushFiles() {
    this.batchTimer = undefined; if (this.disposed || this.batchActive) return;
    const lifecycle = this.lifecycle;
    const entries = [...this.fileEvents.entries()].slice(0, 8);
    for (const [key] of entries) this.fileEvents.delete(key);
    this.batchActive = true;
    try {
      const targets = entries.map(([, entry]) => entry).filter(entry => this.supports(entry.uri));
      if (targets.length === 1) await this.updateFile(targets[0].uri, targets[0].remove);
      else if (targets.length) {
        const scopeKey = this.catalog.scopeKey?.();
        const snapshots = targets.map(entry => {
          const id = uriKey(entry.uri), document = this.catalog.documents().find(doc => !doc.isClosed && uriKey(doc.uri) === id);
          const dirty = !entry.remove && Boolean(document?.isDirty), token = Symbol(), previous = this.dirtyOverlays.get(id);
          if (dirty) this.dirtyOverlays.set(id, token);
          return { ...entry, id, document, dirty, token, previous, version: document?.version,
            file: { uri: entry.uri.toString(), path: entry.uri.fsPath, project: this.catalog.projectKey?.(entry.uri), scopeKey, indexExclude: this.exclude,
              encoding: vscode.workspace.getConfiguration('files', entry.uri).get('encoding', 'utf8'), ...(dirty ? { text: document.getText() } : {}) } };
        });
        const summary = await this.updateRequest('updateBatch', { files: snapshots.map(value => ({ file: value.file, remove: value.remove, dirty: value.dirty })) });
        if (!this.disposed && lifecycle === this.lifecycle && scopeKey === this.catalog.scopeKey?.()) {
          for (const value of snapshots) {
            if (value.dirty && this.dirtyOverlays.get(value.id) === value.token && !value.document.isClosed && value.document.version === value.version)
              this.documentVersions.set(value.id, value.version);
            else if (!value.dirty && this.dirtyOverlays.get(value.id) === value.previous) { this.dirtyOverlays.delete(value.id); this.documentVersions.delete(value.id); }
            if (value.remove) this.coverage.delete(value.id); else this.coverage.add(value.id);
          }
          this.summary = summary; this.revision++; this.report(); this.emitter.fire(undefined);
        }
      }
      for (const [, entry] of entries) for (const waiter of entry.waiters) waiter.resolve();
    } catch (error) { for (const [, entry] of entries) for (const waiter of entry.waiters) waiter.reject(error); }
    finally {
      this.batchActive = false;
      if (this.fileEvents.size && !this.disposed) this.batchTimer = setTimeout(() => this.flushFiles(), 0);
      else if (this.summary && !this.disposed && this.phase !== 'error') this.report();
    }
  }
  async colorResolutions(document, spans) {
    const uri = document.uri;
    // Coloring must never start or wait for a whole project scan.
    if (!this.worker || this.firstSnapshotPending || !this.enabled() || !this.supports(uri) || this.isExcluded(uri, this.exclude || '')) return [];
    return this.request('colorResolutions', { uri: uri.toString(), source: document.getText(), spans: spans.slice(0, 2000) });
  }
  async syncDocument(uri) {
    const id = uriKey(uri);
    const document = this.catalog.documents().find(doc => !doc.isClosed && uriKey(doc.uri) === id);
    if (!document?.isDirty && !this.timers.has(id)) return;
    if (document?.isDirty && this.documentVersions.get(id) === document.version) return;
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    await this.updateFile(uri);
  }
  dispose() {
    clearInterval(this.sharedTimer);
    this.disposed = true; this.refreshSequence++;
    clearTimeout(this.batchTimer);
    for (const entry of this.fileEvents.values()) for (const waiter of entry.waiters) waiter.reject(new Error('本地索引已停止'));
    this.fileEvents.clear();
    this.scanCancellation?.cancel(); this.scanCancellation?.dispose();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.documentVersions.clear(); this.dirtyOverlays.clear(); this.semanticQueries.clear(); this.disposables.forEach(disposable => disposable.dispose()); this.emitter.dispose(); this.statusEmitter.dispose();
    for (const pending of this.pending.values()) { pending.clear(); pending.reject(new Error('本地索引已停止')); }
    this.pending.clear(); const worker = this.worker; this.worker = undefined;
    if (worker) {
      const timer = setTimeout(() => worker.terminate(), 2000); timer.unref(); worker.once('exit', () => clearTimeout(timer));
      try { worker.postMessage({ id: ++this.sequence, action: 'shutdown' }); } catch { clearTimeout(timer); worker.terminate(); }
    }
  }
}
module.exports = { LocalIndex };
