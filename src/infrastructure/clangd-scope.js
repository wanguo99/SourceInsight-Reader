'use strict';
const vscode = require('vscode');
const { relativeUriPath } = require('../resources');
const { scopeConfigurationChanged } = require('./reading-scope');
const { t } = require('../i18n');
const BEGIN = '# BEGIN SourceInsight-Reader managed index scope';
const END = '# END SourceInsight-Reader managed index scope';
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function scopeFragment(scope, root) {
  const snapshot = scope.snapshot();
  if (snapshot.error) throw new Error(snapshot.error);
  const patterns = values => values.flatMap(value => {
    if (relativeUriPath(value.uri, root.uri) !== undefined) return ['.*'];
    const relative = relativeUriPath(root.uri, value.uri);
    return relative === undefined ? [] : [escapeRegex(relative) + '(/.*)?'];
  });
  const excludes = [...patterns(snapshot.excludes), ...snapshot.files.flatMap(file => {
    const relative = relativeUriPath(root.uri, file.uri);
    return relative === undefined ? [] : [escapeRegex(relative)];
  })];
  const fragments = [];
  if (excludes.length) fragments.push('If:\n  PathMatch: ' + JSON.stringify(excludes) + '\nIndex:\n  Background: Skip');
  return fragments.join('\n---\n');
}
function replaceManaged(text, fragment) {
  // Match complete marker lines only; malformed or duplicate blocks are never overwritten.
  const begins = [...text.matchAll(/^# BEGIN SourceInsight-Reader managed index scope(?:; separator=([01]))?\r?$/gm)];
  const ends = [...text.matchAll(/^# END SourceInsight-Reader managed index scope\r?$/gm)];
  if (begins.length !== ends.length || begins.length > 1 || begins.length && begins[0].index >= ends[0].index)
    throw new Error('.clangd 中的自动配置标记不完整或重复，请先检查该文件');
  let original = text;
  if (begins.length) {
    const begin = begins[0], end = ends[0];
    let start = begin.index, finish = end.index + end[0].length;
    if (text[finish] === '\n') finish++;
    if (begin[1] === '1') start -= text.slice(0, start).endsWith('\r\n') ? 2 : 1;
    original = text.slice(0, start) + text.slice(finish);
  }
  if (!fragment) return original;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const separator = Boolean(original && !original.endsWith('\n'));
  return original + (separator ? eol : '') + BEGIN + '; separator=' + Number(separator) + eol +
    '---' + eol + fragment.replace(/\n/g, eol) + eol + END + eol;
}
class ClangdScope {
  constructor(catalog, report, context) {
    this.catalog = catalog; this.report = report; this.context = context; this.pending = Promise.resolve();
    this.previews = new Map();
    if (vscode.workspace.registerTextDocumentContentProvider) this.provider = vscode.workspace.registerTextDocumentContentProvider('sourceinsight-config', { provideTextDocumentContent: uri => this.previews.get(uri.toString()) || '' });
    this.subscriptions = [catalog.onDidChange(event => {
      if (event.kind === 'folders' || event.kind === 'config' && (scopeConfigurationChanged(event.configuration) || event.configuration.affectsConfiguration('sourceInsightReader.autoConfigureClangd'))) this.schedule();
    })];
    // Root .clangd may be outside the selected reading directories, so use a separate watcher.
    const watcher = vscode.workspace.createFileSystemWatcher('**/.clangd');
    const retry = () => this.schedule();
    this.subscriptions.push(watcher, watcher.onDidCreate(retry), watcher.onDidChange(retry), watcher.onDidDelete(retry));
    if (vscode.workspace.onDidSaveTextDocument) this.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.path.endsWith('/.clangd')) this.schedule();
    }));
    if (vscode.workspace.onDidGrantWorkspaceTrust) this.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(retry));
    this.schedule();
  }
  schedule() {
    this.pending = this.pending.then(() => this.sync()).catch(error => this.failure(error));
    return this.pending;
  }
  async sync() {
    if (this.disposed || !vscode.workspace.isTrusted) return;
    const enabled = vscode.workspace.getConfiguration('sourceInsightReader').get('autoConfigureClangd', false);
    for (const root of this.catalog.scope.workspaceRoots()) {
      try { await this.syncRoot(root, enabled); }
      catch (error) { this.failure(error, root.name); }
    }
  }
  failure(error, root = '') {
    const message = 'clangd 目录配置失败' + (root ? '（' + root + '）' : '') + '：' + error.message;
    this.report(message);
    if (!this.disposed && this.lastFailure !== message) vscode.window.showWarningMessage(message);
    this.lastFailure = message;
  }
  dirty(uri) {
    return (vscode.workspace.textDocuments || []).some(doc => doc.isDirty && doc.uri.toString() === uri.toString());
  }
  async read(uri) {
    try { return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); }
    catch (error) { if (error.code === 'FileNotFound' || error.code === 'ENOENT') return ''; throw error; }
  }
  async configure(enabled = true) {
    if (!vscode.workspace.isTrusted) throw new Error(t('请先信任此工作区'));
    const scopeKey = this.catalog.scope.key(), snapshots = [];
    for (const root of this.catalog.scope.workspaceRoots()) {
      const uri = vscode.Uri.joinPath(root.uri, '.clangd');
      if (this.dirty(uri)) throw new Error(t('请先保存 .clangd'));
      const text = await this.read(uri), next = replaceManaged(text, enabled ? scopeFragment(this.catalog.scope, root) : '');
      snapshots.push({ uri, text, next });
    }
    if (!snapshots.length) return;
    const before = vscode.Uri.parse('sourceinsight-config:/before-' + Date.now() + '.yaml');
    const after = vscode.Uri.parse('sourceinsight-config:/after-' + Date.now() + '.yaml');
    this.previews.clear(); this.previews.set(before.toString(), snapshots.map(value => '# ' + value.uri.toString() + '\n' + value.text).join('\n')); this.previews.set(after.toString(), snapshots.map(value => '# ' + value.uri.toString() + '\n' + value.next).join('\n'));
    await vscode.commands.executeCommand('vscode.diff', before, after, t('clangd 范围配置预览'));
    const choice = await vscode.window.showQuickPick([t('应用到所有工作区根目录'), t('取消')], { placeHolder: t('仅维护标记块；原配置会备份，关闭自动维护可移除标记块') });
    if (choice !== t('应用到所有工作区根目录')) return;
    for (const { uri, text } of snapshots) if (this.dirty(uri) || await this.read(uri) !== text || this.catalog.scope.key() !== scopeKey) throw new Error(t('配置已变化，请重新预览'));
    await vscode.workspace.getConfiguration('sourceInsightReader').update('autoConfigureClangd', enabled, vscode.ConfigurationTarget.Workspace);
    await this.schedule();
  }
  async syncRoot(root, enabled) {
    const uri = vscode.Uri.joinPath(root.uri, '.clangd');
    if (this.dirty(uri)) { this.report('等待保存 .clangd 后自动同步：' + uri.toString()); return; }
    const scopeKey = this.catalog.scope.key();
    const text = await this.read(uri);
    const next = replaceManaged(text, enabled ? scopeFragment(this.catalog.scope, root) : '');
    if (next === text || this.disposed || !vscode.workspace.isTrusted) return;
    // Recheck after asynchronous reads: configuration and dirty buffers may have changed.
    if (this.dirty(uri) || scopeKey !== this.catalog.scope.key() ||
      enabled !== vscode.workspace.getConfiguration('sourceInsightReader').get('autoConfigureClangd', false)) return;
    if (await this.read(uri) !== text) { this.schedule(); return; }
    if (this.disposed || this.dirty(uri) || !vscode.workspace.isTrusted || scopeKey !== this.catalog.scope.key() ||
      enabled !== vscode.workspace.getConfiguration('sourceInsightReader').get('autoConfigureClangd', false)) return;
    if (this.context?.storageUri) {
      const crypto = require('node:crypto'), name = crypto.createHash('sha256').update(uri.toString()).digest('hex');
      const directory = vscode.Uri.joinPath(this.context.storageUri, 'clangd-backups');
      await vscode.workspace.fs.createDirectory(directory);
      const backup = vscode.Uri.joinPath(directory, name + '.original');
      let exists = false;
      try { await vscode.workspace.fs.stat(backup); exists = true; } catch (error) { if (!['FileNotFound', 'ENOENT'].includes(error.code)) throw error; }
      if (!exists) await vscode.workspace.fs.writeFile(backup, Buffer.from(text));
    }
    if (this.disposed || this.dirty(uri) || !vscode.workspace.isTrusted || scopeKey !== this.catalog.scope.key() || await this.read(uri) !== text ||
      enabled !== vscode.workspace.getConfiguration('sourceInsightReader').get('autoConfigureClangd', false)) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(next));
    this.lastFailure = undefined;
    this.report('已同步 clangd 后台索引范围：' + uri.toString());
  }
  dispose() { this.disposed = true; this.provider?.dispose(); this.previews.clear(); this.subscriptions.forEach(value => value.dispose()); }
}
module.exports = { ClangdScope, scopeFragment, replaceManaged };
