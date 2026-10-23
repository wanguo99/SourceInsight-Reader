'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { uriKey, relativeUriPath } = require('./resources');
const { scopeConfigurationChanged } = require('./infrastructure/reading-scope');
const { matchesGlob } = require('./infrastructure/workspace-file-catalog');

const REQUEST_TIMEOUT_MS = 60000;
const SCAN_FILE_TIMEOUT_MS = 1000;
// Node timers overflow above this delay and would fire almost immediately.
const MAX_TIMEOUT_MS = 2147483647;

function excluded(uri, pattern) { return matchesGlob(uri.path, pattern); }

// Extension-host facade; parsing, relation resolution and persistence stay off
// the UI thread. The first cache format is a versioned JSON facts snapshot.
class LocalIndex {
  constructor(context, catalog, log = message => {}) {
    this.catalog = catalog; this.context = context; this.log = log; this.sequence = 0; this.pending = new Map(); this.refreshSequence = 0;
    this.disposables = []; this.timers = new Map(); this.disposed = false;
    this.documentVersions = new Map(); this.dirtyOverlays = new Map(); this.revision = 0; this.phase = 'idle'; this.coverage = new Set();
    this.statusEmitter = new vscode.EventEmitter(); this.onDidChangeStatus = this.statusEmitter.event;
    this.emitter = new vscode.EventEmitter(); this.onDidChange = this.emitter.event;
    this.status = '本地 C 索引尚未建立'; this.operation = 'creating'; this.activeUpdates = 0; this.activeScans = 0;
  }
  getStatus() {
    if (!this.enabled()) return { scope: 'index', phase: 'disabled', operation: this.operation, message: '本地 C 索引已关闭', busy: false };
    return { scope: 'index', phase: this.phase, operation: this.operation, message: this.status + (this.catalog.scope?.restricted() ? ' · ' + this.catalog.scope.description() : ''),
      busy: this.phase !== 'error' && (this.phase === 'building' || this.timers.size > 0 || this.activeUpdates > 0 || this.activeScans > 0) };
  }
  beginUpdate() {
    this.operation = this.summary ? 'updating' : 'creating';
    this.phase = 'building';
    this.status = this.operation === 'creating' ? '索引创建中…' : '索引更新中…';
    this.statusEmitter.fire(this.status);
  }
  async updateRequest(action, data) {
    this.activeUpdates++; this.beginUpdate();
    try { return await this.request(action, data); }
    catch (error) {
      this.phase = 'error'; this.status = `索引更新失败：${error.message}`; this.statusEmitter.fire(this.status); throw error;
    } finally { this.activeUpdates--; }
  }
  enabled() { return vscode.workspace.getConfiguration('sourceInsightReader').get('indexEnabled', true); }
  supports(uri, scopeSnapshot) { return uri.scheme === 'file' && /\.(c|h)$/i.test(uri.path) &&
    (this.catalog.contains ? this.catalog.contains(uri, scopeSnapshot) : vscode.workspace.workspaceFolders?.some(folder => relativeUriPath(folder.uri, uri) !== undefined)); }
  describe(uri) {
    if (!this.enabled()) return { state: 'disabled', note: '本地 C 索引未启用' };
    if (this.catalog.accepts && !this.catalog.accepts(uri)) return { state: 'excluded', note: '当前文件已被屏蔽或不在工作区内' };
    if (!this.supports(uri)) return { state: 'unsupported', note: '文件不在本地 C 索引支持的工作区 / 扩展名范围' };
    if (this.exclude && excluded(uri, this.exclude)) return { state: 'excluded', note: '文件被 indexExclude 排除' };
    if (this.summaryScope !== undefined && this.summaryScope !== this.catalog.scopeKey?.()) return { state: 'building', note: '屏蔽规则已改变，正在更新索引' };
    if (this.phase === 'building') return { state: 'building', note: this.status };
    if (this.phase === 'error') return { state: 'error', note: this.status };
    if (this.phase === 'idle') return { state: 'building', note: '本地 C 索引尚未建立，将自动建立' };
    if (!this.coverage.has(uriKey(uri))) return { state: 'notIndexed', note: '当前文件未被本地索引收录' };
    if (this.summary?.failures?.some(failure => failure.uri === uri.toString())) return { state: 'error', note: '当前文件索引更新失败，详见输出' };
    return { state: 'ready', note: this.status };
  }
  request(action, data = {}) {
    if (this.disposed || !this.worker) return Promise.reject(new Error('本地索引已停止'));
    const id = ++this.sequence;
    const fileCount = action === 'scan' ? data.files.length : 0;
    const timeout = Math.min(REQUEST_TIMEOUT_MS + fileCount * SCAN_FILE_TIMEOUT_MS, MAX_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(action === 'scan'
          ? `本地 C 索引扫描超时（${fileCount} 个文件，等待上限 ${Math.ceil(timeout / 1000)} 秒），请重建索引`
          : '本地索引查询超时，请刷新 Relation'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, action, ...data }); } catch (error) {
        this.pending.delete(id); clearTimeout(timer); reject(error);
      }
    });
  }
  fail(error) {
    this.phase = 'error'; this.revision++;
    this.status = `本地索引不可用：${error.message || error}`; this.log(this.status); this.statusEmitter.fire(this.status);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.ready = undefined;
    const worker = this.worker; this.worker = undefined; worker?.terminate();
  }
  async ensure(force = false) {
    if (this.disposed || !this.enabled() || !vscode.workspace.workspaceFolders?.length ||
      typeof vscode.workspace.findFiles !== 'function') return false;
    if (this.worker && this.summary && (this.summaryScope === undefined || this.summaryScope === this.catalog.scopeKey?.())) return true;
    if (!this.ready) this.ready = this.start(force).catch(error => { this.fail(error); throw error; });
    await this.ready; return Boolean(this.summary) && (this.summaryScope === undefined || this.summaryScope === this.catalog.scopeKey?.());
  }
  async start(force = false) {
    this.beginUpdate();
    this.worker = new Worker(path.join(__dirname, 'index-worker.js'));
    const worker = this.worker;
    this.worker.on('message', message => {
      if (message.diagnostic) { this.log(`索引缓存保存失败：${message.diagnostic}`); return; }
      if (message.progress) {
        this.status = `${this.operation === 'creating' ? '索引创建中' : '索引更新中'}… ${message.progress.done}/${message.progress.total} 个文件`; this.statusEmitter.fire(this.status); return;
      }
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    this.worker.on('error', error => { if (!this.disposed && this.worker === worker) this.fail(error); });
    this.worker.on('exit', code => {
      if (!this.disposed && this.worker === worker) this.fail(new Error(`索引进程退出：${code}`));
    });
    if (!this.watching) { this.watching = true; this.watch(); }
    return this.scan(force);
  }
  async scan(force = false) {
    this.beginUpdate();
    const scopeKey = this.catalog.scopeKey?.();
    const scopeProject = this.catalog.scope?.restricted() ? 'reading-directories:' + scopeKey : undefined;
    const scopeRoots = this.catalog.roots?.().map(root => ({ uri: root.uri.toString(), project: this.catalog.projectKey?.(root.uri) }));
    const exclude = vscode.workspace.getConfiguration('sourceInsightReader').get('indexExclude',
      '**/{.git,.cache,node_modules,build,dist,out,research}/**');
    this.exclude = exclude;
    this.scanCancellation?.dispose();
    const cancellation = new vscode.CancellationTokenSource(); this.scanCancellation = cancellation;
    let uris;
    try { uris = await this.catalog.list({ pattern: '**/*.{c,C,h,H}', exclude, force, cancellation: cancellation.token }); }
    catch (error) { if (cancellation.token.isCancellationRequested || scopeKey !== this.catalog.scopeKey?.()) return { cancelled: true }; throw error; }
    if (this.disposed || cancellation.token.isCancellationRequested || scopeKey !== this.catalog.scopeKey?.()) return { cancelled: true };
    const open = new Map(this.catalog.documents().filter(doc => !doc.isClosed && doc.isDirty).map(doc => [uriKey(doc.uri), doc]));
    const scopeSnapshot = this.catalog.scope?.snapshot();
    const files = uris.filter(uri => this.supports(uri, scopeSnapshot)).map(uri => {
      const document = open.get(uriKey(uri));
      return { uri: uri.toString(), path: uri.fsPath, project: this.catalog.projectKey ? this.catalog.projectKey(uri, scopeSnapshot) : this.catalog.folder?.(uri)?.uri.toString(), ...(document ? { text: document.getText() } : {}) };
    });
    const dirtySnapshots = files.filter(file => file.text !== undefined).map(file => {
      const id = uriKey(vscode.Uri.parse(file.uri)), document = open.get(id), token = Symbol();
      this.dirtyOverlays.set(id, token); return { id, document, version: document.version, token };
    });
    this.activeScans++;
    let summary;
    try { summary = await this.request('scan', { files, force, scopeProject, scopeRoots,
      cachePath: this.context.storageUri ? path.join(this.context.storageUri.fsPath, 'c-index-v2.json') : undefined }); }
    finally { this.activeScans--; }
    if (summary.cancelled || cancellation.token.isCancellationRequested || scopeKey !== this.catalog.scopeKey?.()) return { ...summary, cancelled: true };
    this.coverage = new Set(files.map(file => uriKey(vscode.Uri.parse(file.uri))));
    for (const snapshot of dirtySnapshots) {
      if (this.dirtyOverlays.get(snapshot.id) === snapshot.token && !snapshot.document.isClosed && snapshot.document.version === snapshot.version)
        this.documentVersions.set(snapshot.id, snapshot.version);
    }
    this.summaryScope = scopeKey; this.summary = summary; this.revision++; this.report(); this.emitter.fire(undefined); return summary;
  }
  report() {
    this.phase = this.timers.size || this.activeUpdates || this.activeScans ? 'building' : 'ready';
    const summary = this.summary;
    this.status = `本地 C 索引：${summary.files} 个文件，${summary.functions} 个函数，${summary.calls} 处调用` +
      (summary.failures?.length ? `，${summary.failures.length} 个文件/缓存处理失败` : '') +
      (summary.errors ? `，${summary.errors} 个文件含语法错误` : '');
    if (this.phase === 'building') this.status = this.operation === 'creating' ? '索引创建中…' : '索引更新中…';
    this.log(this.status); this.statusEmitter.fire(this.status);
    for (const error of summary.failures || []) this.log(`${error.uri}: ${error.message}`);
  }
  watch() {
    const schedule = (uri, remove = false) => {
      if (!this.enabled() || !this.supports(uri) || !this.worker || excluded(uri, this.exclude || '')) return;
      const id = uriKey(uri); clearTimeout(this.timers.get(id)); this.beginUpdate();
      if (remove) { this.documentVersions.delete(id); this.dirtyOverlays.delete(id); }
      this.timers.set(id, setTimeout(async () => {
        this.timers.delete(id);
        if (!this.enabled() || !this.supports(uri)) return;
        try {
          await this.ready;
          if (!this.supports(uri)) return;
          await this.updateFile(uri, remove);
        } catch (error) { this.log(`本地索引更新失败：${error.message}`); this.status = `本地索引更新失败：${error.message}`; this.phase = 'error'; this.statusEmitter.fire(this.status); }
      }, 350));
    };
    this.disposables.push(this.catalog.onDidChange(event => {
      if (event.kind === 'folders') { this.refresh().catch(error => this.log(error.message)); return; }
      if (event.kind === 'config') {
        if (event.configuration.affectsConfiguration('sourceInsightReader.indexEnabled') || event.configuration.affectsConfiguration('sourceInsightReader.indexExclude') || scopeConfigurationChanged(event.configuration)) {
          if (scopeConfigurationChanged(event.configuration)) {
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
    // Initial startup already performs a scan; do not scan the entire project twice.
    if (!this.worker) { await this.ensure(force); return; }
    if (this.disposed || !this.enabled()) return;
    const previous = this.ready, sequence = ++this.refreshSequence;
    this.beginUpdate();
    const pending = Promise.resolve(previous).then(() => {
      if (!this.disposed && this.enabled() && sequence === this.refreshSequence) return this.scan(force);
    }).catch(error => { this.fail(error); throw error; });
    this.ready = pending; await pending;
  }
  convert(item) {
    const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
    return { ...item, uri: vscode.Uri.parse(item.uri), range: range(item.range), selectionRange: range(item.selectionRange),
      ...(item.children ? { children: item.children.map(child => this.convert(child)) } : {}) };
  }
  async prepare(uri, position, name) {
    if (!this.supports(uri) || !await this.ensure()) return [];
    await this.syncDocument(uri);
    const items = await this.request('prepare', { uri: uri.toString(), position: { line: position.line, character: position.character }, name });
    const suffix = this.summary?.failures?.length ? ' · 部分文件未更新，详见输出' : '';
    return items.map(item => this.convert({ ...item, detail: item.detail + suffix }));
  }
  async callDiagnostics(item, direction) {
    return this.request('callDiagnostics', { item: { sourceInsightReaderLocal: item.sourceInsightReaderLocal }, direction });
  }
  async calls(item, direction) {
    if (!await this.ensure()) return [];
    const calls = await this.request('calls', { item: { sourceInsightReaderLocal: item.sourceInsightReaderLocal }, direction });
    const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
    return calls.map(call => direction === 'incoming'
      ? { from: this.convert(call.from), fromRanges: call.fromRanges.map(range) }
      : { to: this.convert(call.to), fromRanges: call.fromRanges.map(range) });
  }
  async definitions(uri, position) {
    if (!this.supports(uri) || !await this.ensure()) return [];
    await this.syncDocument(uri);
    const items = await this.request('definitions', { uri: uri.toString(), position: { line: position.line, character: position.character } });
    return items.map(item => { const value = this.convert(item); return { uri: value.uri, range: value.selectionRange }; });
  }
  async workspaceSymbols(query) {
    if (!await this.ensure()) return [];
    for (const document of this.catalog.documents()) {
      if (!document.isClosed && document.isDirty && this.supports(document.uri)) await this.syncDocument(document.uri);
    }
    const values = await this.request('workspaceSymbols', { query });
    return values.map(item => ({ name: item.name, kind: item.kind, containerName: item.containerName,
      location: { uri: vscode.Uri.parse(item.uri), range: new vscode.Range(item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character) } }));
  }
  async symbols(uri) {
    if (!this.supports(uri) || !await this.ensure()) return [];
    await this.syncDocument(uri);
    return (await this.request('symbols', { uri: uri.toString() })).map(item => this.convert(item));
  }
  async updateFile(uri, remove = false) {
    if (!this.supports(uri)) return;
    const id = uriKey(uri), document = this.catalog.documents().find(doc => !doc.isClosed && uriKey(doc.uri) === id);
    const dirty = !remove && Boolean(document?.isDirty), version = dirty ? document.version : undefined;
    const previousOverlay = this.dirtyOverlays.get(id), token = Symbol();
    if (dirty) this.dirtyOverlays.set(id, token);
    const summary = remove ? await this.updateRequest('remove', { uri: uri.toString() })
      : await this.updateRequest('update', { file: { uri: uri.toString(), path: uri.fsPath, project: this.catalog.projectKey ? this.catalog.projectKey(uri) : this.catalog.folder?.(uri)?.uri.toString(),
        ...(dirty ? { text: document.getText() } : {}) }, dirty });
    if (dirty) {
      if (this.dirtyOverlays.get(id) === token && !document.isClosed && document.version === version) this.documentVersions.set(id, version);
    } else if (this.dirtyOverlays.get(id) === previousOverlay) {
      this.dirtyOverlays.delete(id); this.documentVersions.delete(id);
    }
    this.summary = summary;
    if (remove) this.coverage.delete(id); else this.coverage.add(id);
    this.revision++; this.report(); this.emitter.fire(uri);
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
    this.disposed = true; this.refreshSequence++;
    this.scanCancellation?.cancel(); this.scanCancellation?.dispose();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.documentVersions.clear(); this.dirtyOverlays.clear(); this.disposables.forEach(disposable => disposable.dispose()); this.emitter.dispose(); this.statusEmitter.dispose();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('本地索引已停止')); }
    this.pending.clear(); const worker = this.worker; this.worker = undefined;
    if (worker) {
      const timer = setTimeout(() => worker.terminate(), 2000); timer.unref(); worker.once('exit', () => clearTimeout(timer));
      try { worker.postMessage({ id: ++this.sequence, action: 'shutdown' }); } catch { clearTimeout(timer); worker.terminate(); }
    }
  }
}
module.exports = { LocalIndex };
