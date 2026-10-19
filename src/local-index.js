'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { uriKey, relativeUriPath } = require('./resources');
const { globRegex } = require('./core');

function excluded(uri, pattern) {
  const expand = value => {
    const match = value.match(/\{([^{}]+)\}/);
    return match ? match[1].split(',').flatMap(part => expand(value.replace(match[0], part))) : [value];
  };
  return expand(pattern).some(value => globRegex(value).test(uri.path));
}

// Extension-host facade; parsing, relation resolution and persistence stay off
// the UI thread. The first cache format is a versioned JSON facts snapshot.
class LocalIndex {
  constructor(context, log = message => {}) {
    this.context = context; this.log = log; this.sequence = 0; this.pending = new Map();
    this.disposables = []; this.timers = new Map(); this.disposed = false;
    this.documentVersions = new Map(); this.revision = 0; this.phase = 'idle'; this.coverage = new Set();
    this.statusEmitter = new vscode.EventEmitter(); this.onDidChangeStatus = this.statusEmitter.event;
    this.emitter = new vscode.EventEmitter(); this.onDidChange = this.emitter.event;
    this.status = '本地 C 索引尚未建立';
  }
  enabled() { return vscode.workspace.getConfiguration('sourceInsightInspired').get('relationBackend', String('auto')) !== 'languageService'; }
  supports(uri) { return uri.scheme === 'file' && /\.(c|h)$/i.test(uri.path) &&
    vscode.workspace.workspaceFolders?.some(folder => relativeUriPath(folder.uri, uri) !== undefined); }
  describe(uri) {
    if (!this.enabled()) return { state: 'disabled', note: '本地 C 索引未启用' };
    if (!this.supports(uri)) return { state: 'unsupported', note: '文件不在本地 C 索引支持的工作区 / 扩展名范围' };
    if (this.exclude && excluded(uri, this.exclude)) return { state: 'excluded', note: '文件被 indexExclude 排除' };
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('本地索引查询超时，请刷新 Relation'));
      }, 60000);
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
  async ensure() {
    if (this.disposed || !this.enabled() || !vscode.workspace.workspaceFolders?.length ||
      typeof vscode.workspace.findFiles !== 'function') return false;
    if (!this.ready) this.ready = this.start().catch(error => { this.fail(error); throw error; });
    await this.ready; return true;
  }
  async start() {
    this.phase = 'building'; this.status = '正在建立本地 C 调用索引…'; this.statusEmitter.fire(this.status);
    this.worker = new Worker(path.join(__dirname, 'index-worker.js'));
    const worker = this.worker;
    this.worker.on('message', message => {
      if (message.progress) {
        this.status = `本地 C 索引：${message.progress.done}/${message.progress.total}`; this.statusEmitter.fire(this.status); return;
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
    return this.scan();
  }
  async scan(force = false) {
    this.phase = 'building'; this.status = '正在扫描本地 C 索引…'; this.statusEmitter.fire(this.status);
    const exclude = vscode.workspace.getConfiguration('sourceInsightInspired').get('indexExclude',
      '**/{.git,.cache,node_modules,build,dist,out,research}/**');
    this.exclude = exclude;
    const uris = await vscode.workspace.findFiles('**/*.{c,C,h,H}', exclude);
    if (this.disposed) return;
    const open = new Map((vscode.workspace.textDocuments || []).filter(doc => doc.isDirty).map(doc => [uriKey(doc.uri), doc]));
    const files = uris.filter(uri => this.supports(uri)).map(uri => {
      const document = open.get(uriKey(uri));
      return { uri: uri.toString(), path: uri.fsPath, ...(document ? { text: document.getText() } : {}) };
    });
    const summary = await this.request('scan', { files, force,
      cachePath: this.context.storageUri ? path.join(this.context.storageUri.fsPath, 'c-index-v1.json') : undefined });
    this.coverage = new Set(files.map(file => uriKey(vscode.Uri.parse(file.uri))));
    this.summary = summary; this.revision++; this.report(); this.emitter.fire(undefined); return summary;
  }
  report() {
    this.phase = 'ready';
    const summary = this.summary;
    this.status = `本地 C 索引：${summary.files} 个文件，${summary.functions} 个函数，${summary.calls} 处调用` +
      (summary.failures?.length ? `，${summary.failures.length} 个文件/缓存处理失败` : '') +
      (summary.errors ? `，${summary.errors} 个文件含语法错误` : '');
    this.log(this.status); this.statusEmitter.fire(this.status);
    for (const error of summary.failures || []) this.log(`${error.uri}: ${error.message}`);
  }
  watch() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{c,C,h,H}');
    const schedule = (uri, remove = false) => {
      if (!this.enabled() || !this.supports(uri) || !this.worker || excluded(uri, this.exclude || '')) return;
      const id = uriKey(uri); clearTimeout(this.timers.get(id));
      if (remove) this.documentVersions.delete(id);
      this.timers.set(id, setTimeout(async () => {
        this.timers.delete(id);
        if (!this.enabled()) return;
        try {
          await this.ready;
          const document = (vscode.workspace.textDocuments || []).find(doc => uriKey(doc.uri) === id);
          const result = remove ? await this.request('remove', { uri: uri.toString() })
            : await this.request('update', { file: { uri: uri.toString(), path: uri.fsPath,
              ...(document?.isDirty ? { text: document.getText() } : {}) }, dirty: Boolean(document?.isDirty) });
          this.summary = result; this.revision++;
          if (remove) this.coverage.delete(id); else this.coverage.add(id);
          this.report(); this.emitter.fire(uri);
        } catch (error) { this.log(`本地索引更新失败：${error.message}`); this.status = `本地索引更新失败：${error.message}`; this.phase = 'error'; this.statusEmitter.fire(this.status); }
      }, 350));
    };
    this.disposables.push(watcher, watcher.onDidCreate(uri => schedule(uri)),
      watcher.onDidChange(uri => schedule(uri)), watcher.onDidDelete(uri => schedule(uri, true)),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length) schedule(event.document.uri);
      }));
    if (vscode.workspace.onDidSaveTextDocument) this.disposables.push(vscode.workspace.onDidSaveTextDocument(doc => schedule(doc.uri)));
    if (vscode.workspace.onDidCloseTextDocument) this.disposables.push(vscode.workspace.onDidCloseTextDocument(doc => {
      this.documentVersions.delete(uriKey(doc.uri)); schedule(doc.uri);
    }));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.refresh().catch(error => this.log(error.message));
    }));
  }
  async refresh(force = false) {
    if (!await this.ensure()) return;
    const pending = this.scan(force).catch(error => { this.fail(error); throw error; });
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
    const items = await this.request('prepare', { uri: uri.toString(), position, name });
    const suffix = this.summary?.failures?.length ? ' · 部分文件未更新，详见输出' : '';
    return items.map(item => this.convert({ ...item, detail: item.detail + suffix }));
  }
  async calls(item, direction) {
    if (!await this.ensure()) return [];
    const calls = await this.request('calls', { item: { sourceInsightInspiredLocal: item.sourceInsightInspiredLocal }, direction });
    const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
    return calls.map(call => direction === 'incoming'
      ? { from: this.convert(call.from), fromRanges: call.fromRanges.map(range) }
      : { to: this.convert(call.to), fromRanges: call.fromRanges.map(range) });
  }
  async definitions(uri, position) {
    if (!this.supports(uri) || !await this.ensure()) return [];
    await this.syncDocument(uri);
    const items = await this.request('definitions', { uri: uri.toString(), position });
    return items.map(item => { const value = this.convert(item); return { uri: value.uri, range: value.selectionRange }; });
  }
  async symbols(uri) {
    if (!this.supports(uri) || !await this.ensure()) return [];
    await this.syncDocument(uri);
    return (await this.request('symbols', { uri: uri.toString() })).map(item => this.convert(item));
  }
  async syncDocument(uri) {
    const id = uriKey(uri);
    const document = (vscode.workspace.textDocuments || []).find(doc => uriKey(doc.uri) === id);
    if (!document?.isDirty && !this.timers.has(id)) return;
    const version = document?.isDirty ? document.version : undefined;
    if (version !== undefined && this.documentVersions.get(id) === version) return;
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    this.summary = await this.request('update', { file: { uri: uri.toString(), path: uri.fsPath,
      ...(document?.isDirty ? { text: document.getText() } : {}) }, dirty: Boolean(document?.isDirty) });
    if (version !== undefined) this.documentVersions.set(id, version); else this.documentVersions.delete(id);
    this.coverage.add(id); this.revision++; this.report(); this.emitter.fire(uri);
  }
  dispose() {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.disposables.forEach(disposable => disposable.dispose()); this.emitter.dispose(); this.statusEmitter.dispose();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('本地索引已停止')); }
    this.pending.clear(); this.worker?.terminate(); this.worker = undefined;
  }
}
module.exports = { LocalIndex };
