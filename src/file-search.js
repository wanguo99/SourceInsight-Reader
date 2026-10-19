'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const { RequestGate, globRegex } = require('./core');
const { relativeUriPath } = require('./resources');

function fuzzyScore(text, query) {
  const value = text.toLowerCase(), needle = query.toLowerCase();
  const direct = value.indexOf(needle);
  if (direct >= 0) return 100 + needle.length * 4 - direct * 0.2;
  let at = 0, score = 0, previous = -2;
  for (const char of needle) {
    const found = value.indexOf(char, at); if (found < 0) return undefined;
    score += 2 + (found === previous + 1 ? 5 : 0) + (found === 0 || /[/_.\-]/.test(value[found - 1]) ? 8 : 0);
    score -= Math.min(20, found - at); previous = found; at = found + char.length;
  }
  return score;
}
function rankFiles(files, query, limit = 200) {
  const tokens = query.trim().replace(/\\/g, '/').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { rows: [], total: 0 };
  const matches = [];
  for (const file of files) {
    let score = 0, match = true;
    for (const token of tokens) {
      const part = fuzzyScore(file.path, token);
      if (part === undefined) { match = false; break; }
      score += part;
      const name = fuzzyScore(file.name, token);
      if (name !== undefined) score += 40 + name;
    }
    if (match) matches.push({ file, score: score - file.path.length * 0.02 });
  }
  matches.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  return { rows: matches.slice(0, limit).map(match => match.file), total: matches.length };
}

class FileSearchView {
  constructor(context, open, fail) {
    this.context = context; this.open = open; this.fail = fail;
    this.query = context.workspaceState.get('fileSearch.query', ''); this.files = []; this.targets = new Map();
    this.serial = 0; this.scanGate = new RequestGate(); this.dirty = true; this.disposables = [];
    const changed = () => {
      this.dirty = true; clearTimeout(this.timer);
      if (this.view?.visible) this.timer = setTimeout(() => this.refresh().catch(fail), 250);
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(watcher, watcher.onDidCreate(changed), watcher.onDidDelete(changed),
      vscode.workspace.onDidChangeWorkspaceFolders(changed),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('files.exclude') || event.affectsConfiguration('sourceInsightInspired.files')) changed();
      }));
  }
  resolveWebviewView(view) {
    this.view = view;
    const webview = view.webview, nonce = crypto.randomBytes(16).toString('hex');
    const asset = name => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, `media/${name}`));
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${asset('file-search.css')}"><title>文件搜索</title></head><body>
<div class="search"><input id="query" type="search" placeholder="模糊搜索路径 / 文件名…" aria-label="模糊搜索路径和文件名" autocomplete="off" spellcheck="false"><button id="clear" title="清空搜索" aria-label="清空搜索">×</button><button id="refresh" title="刷新文件列表" aria-label="刷新文件列表">↻</button></div>
<div id="status" role="status" aria-live="polite"></div><div id="results" aria-label="匹配文件"></div>
<script nonce="${nonce}" src="${asset('file-search.js')}"></script></body></html>`;
    this.messages?.dispose(); this.visibility?.dispose();
    this.messages = webview.onDidReceiveMessage(message => this.handleMessage(message).catch(this.fail));
    this.visibility = view.onDidChangeVisibility(() => { if (view.visible && this.dirty) this.refresh().catch(this.fail); });
    this.refresh().catch(this.fail);
  }
  async refresh() {
    if (!this.view || this.disposed) { this.dirty = true; return; }
    const request = this.scanGate.next(); this.busy = true; this.error = ''; await this.publish();
    try {
      const uris = await vscode.workspace.findFiles('**/*', undefined, 50001);
      if (!this.scanGate.current(request)) return;
      const roots = [...(vscode.workspace.workspaceFolders || [])].sort((a, b) => b.uri.path.length - a.uri.path.length);
      const rules = new Map(roots.map(root => {
        const config = vscode.workspace.getConfiguration('sourceInsightInspired', root.uri);
        return [root, { exclude: config.get('files.exclude', []).map(globRegex), include: config.get('files.include', []).map(globRegex) }];
      }));
      this.files = uris.slice(0, 50000).flatMap(uri => {
        const root = roots.find(folder => relativeUriPath(folder.uri, uri) !== undefined); if (!root) return [];
        const relative = relativeUriPath(root.uri, uri), rule = rules.get(root);
        const prefixes = relative.split('/').map((_, i, segments) => segments.slice(0, i + 1).join('/'));
        if (rule.exclude.some(regex => prefixes.some(prefix => regex.test(prefix))) ||
          rule.include.length && !rule.include.some(regex => regex.test(relative))) return [];
        return [{ uri, name: relative.split('/').pop(), path: roots.length > 1 ? `${root.name}/${relative}` : relative }];
      });
      this.limited = uris.length > 50000; this.dirty = false;
    } catch (error) {
      if (!this.scanGate.current(request)) return;
      this.error = `文件扫描失败：${error.message}`; this.dirty = true;
    } finally {
      if (this.scanGate.current(request)) { this.busy = false; await this.publish(); }
    }
  }
  async focus() {
    this.focusRequested = true;
    await vscode.commands.executeCommand('sourceInsightInspired.fileSearch.focus');
    if (this.view) { this.focusRequested = false; await this.view.webview.postMessage({ focusSearch: true }); }
  }
  async handleMessage(message) {
    if (this.disposed) return;
    if (message.action === 'ready') {
      await this.publish();
      if (this.focusRequested) { this.focusRequested = false; await this.view?.webview.postMessage({ focusSearch: true }); }
      return;
    }
    if (message.action === 'refresh') return this.refresh();
    if (message.action === 'search' && typeof message.query === 'string') {
      this.query = message.query.slice(0, 500); await this.publish();
      await this.context.workspaceState.update('fileSearch.query', this.query); return;
    }
    if (message.action !== 'open') return;
    const file = this.targets.get(message.id); if (!file) return;
    await this.open({ uri: file.uri, range: new vscode.Range(0, 0, 0, 0), name: file.name });
    await vscode.commands.executeCommand('revealInExplorer', file.uri);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }
  async publish() {
    if (!this.view || this.disposed) return;
    const { rows, total } = rankFiles(this.files, this.query);
    this.targets.clear();
    const results = rows.map(file => {
      const id = String(++this.serial); this.targets.set(id, file);
      return { id, name: file.name, path: file.path, tooltip: file.uri.fsPath || file.uri.path };
    });
    await this.view.webview.postMessage({ query: this.query, rows: results,
      status: this.error || (this.busy ? '正在扫描文件…' : !vscode.workspace.workspaceFolders?.length ? '请先打开文件夹或工作区'
        : !this.query.trim() ? '输入路径和文件名，空格分隔，例如 src main'
          : `${total} 个匹配${total > 200 ? '，显示前 200 项，请缩小范围' : ''}`) +
        (this.limited ? ' · 仅扫描前 50000 个文件' : '') });
  }
  dispose() {
    this.disposed = true; clearTimeout(this.timer); this.scanGate.dispose();
    this.messages?.dispose(); this.visibility?.dispose(); this.disposables.forEach(item => item.dispose()); this.targets.clear();
  }
}
module.exports = { FileSearchView, fuzzyScore, rankFiles };
