'use strict';
const vscode = require('vscode');
const queryState = require('./domain/query-state');
const { queryResult } = require('./domain/model');
const { RequestGate, enclosingFunction, globRegex } = require('./core');
const { uriKey, relativeUriPath } = require('./resources');
const { expand } = require('./infrastructure/workspace-file-catalog');
const DEFAULT_EXCLUDE = '**/{.git,.cache,node_modules,build,dist,out,research}/**';

function literalPattern(query, matchCase = false) {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
}
function identifierCharacter(value) { return Boolean(value && /[\p{ID_Continue}$]/u.test(value)); }
function previousCharacter(text, at) {
  if (!at) return '';
  const value = text.charCodeAt(at - 1);
  return value >= 0xdc00 && value <= 0xdfff && at > 1 ? text.slice(at - 2, at) : text[at - 1];
}
function findMatches(text, query, options = {}, limit = 20000) {
  if (!query || /[\r\n]/.test(query)) return [];
  const regex = literalPattern(query, options.matchCase), rows = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (let line = 0; line < lines.length; line++) {
    regex.lastIndex = 0; let match;
    while ((match = regex.exec(lines[line]))) {
      const start = match.index, end = start + match[0].length;
      if (options.wholeWord && (identifierCharacter(previousCharacter(lines[line], start)) ||
        identifierCharacter(end < lines[line].length ? String.fromCodePoint(lines[line].codePointAt(end)) : ''))) continue;
      const from = Math.max(0, start - 80), to = Math.min(lines[line].length, Math.max(from + 260, end));
      rows.push({ line, start, end, match: match[0], lineText: lines[line],
        before: (from ? '…' : '') + lines[line].slice(from, start), matched: match[0],
        after: lines[line].slice(end, to) + (to < lines[line].length ? '…' : '') });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}
function expandGlob(pattern) { return expand(pattern).map(globRegex); }
function excluded(relative, patterns) {
  const prefixes = relative.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
  return patterns.some(regex => prefixes.some(prefix => regex.test(prefix)));
}
function folderFor(uri) {
  return [...(vscode.workspace.workspaceFolders || [])].sort((a, b) => b.uri.path.length - a.uri.path.length)
    .find(folder => uri && relativeUriPath(folder.uri, uri) !== undefined);
}

class TextLookup {
  constructor(catalog, symbols = async uri => [], limits = {}) {
    this.catalog = catalog; this.symbols = symbols; this.limits = { files: 20000, matches: 20000, bytes: 4 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, ...limits };
    this.gate = new RequestGate(); this.emitter = new vscode.EventEmitter(); this.onDidChange = this.emitter.event;
    this.queryState = queryState.idle(); this.rows = []; this.history = []; this.options = { matchCase: false, wholeWord: false }; this.selected = -1;
    this.message = '输入字符，搜索当前文件夹'; this.serial = 0;
    this.disposables = [this.catalog.onDidChange(event => {
      if (event.kind === 'config') {
        if (['sourceInsightReader.textLookupExclude', 'files.exclude', 'search.exclude'].some(key => event.configuration.affectsConfiguration(key))) this.markStale();
      } else if (event.kind === 'folders') this.markStale();
      else if (event.uri && event.kind !== 'close') this.markStale(event.uri);
    })];
  }
  get busy() { return ['loading', 'refreshing'].includes(this.queryState.status); }
  get stale() { return this.queryState.status === 'stale'; }
  changed() { this.emitter.fire(undefined); }
  markStale(uri) {
    if (!this.query || !this.folder || uri && relativeUriPath(this.folder.uri, uri) === undefined) return;
    if (uri && this.patterns && excluded(relativeUriPath(this.folder.uri, uri), this.patterns)) return;
    this.gate.invalidate(); this.cancellation?.cancel(); this.queryState = queryState.stale(this.queryState, this.gate.version);
    this.message = '源码或文件夹已变化，请刷新检索'; this.changed();
  }
  clear() {
    this.gate.invalidate(); this.cancellation?.cancel(); this.rows = []; this.query = ''; this.selected = -1;
    this.queryState = queryState.idle(this.gate.version); this.message = '输入字符，搜索当前文件夹'; this.changed();
  }
  async search(query, folder, options = this.options) {
    this.cancellation?.cancel(); this.cancellation?.dispose();
    this.cancellation = new vscode.CancellationTokenSource();
    const request = this.gate.next(), cancellation = this.cancellation;
    this.query = query; this.folder = folder; this.options = { matchCase: Boolean(options.matchCase), wholeWord: Boolean(options.wholeWord) };
    this.rows = []; this.selected = -1; this.queryState = queryState.idle(this.gate.version); this.stats = undefined;
    if (!query || /[\r\n]/.test(query) || query.length > 256 || !folder) {
      this.message = !folder ? '请先打开并选择工作区文件夹' : !query ? '输入字符，搜索当前文件夹' : '请输入不超过 256 个字符的单行检索内容';
      this.changed(); return;
    }
    this.history = [{ query, folder: folder.uri.toString(), ...this.options }, ...this.history.filter(item =>
      !(item.query === query && item.folder === folder.uri.toString() && item.matchCase === this.options.matchCase && item.wholeWord === this.options.wholeWord))].slice(0, 20);
    this.queryState = queryState.begin(this.queryState, request, String(request)); this.message = '正在枚举文件…'; this.changed();
    const state = { scanned: 0, skipped: 0, failed: 0, bytes: 0, reasons: new Set(), rows: [], stop: false };
    let failure;
    try {
      const custom = vscode.workspace.getConfiguration('sourceInsightReader', folder.uri).get('textLookupExclude', DEFAULT_EXCLUDE);
      const fileExclude = vscode.workspace.getConfiguration('files', folder.uri).get('exclude', {});
      const searchExclude = vscode.workspace.getConfiguration('search', folder.uri).get('exclude', {});
      this.patterns = [custom, ...[...Object.entries(fileExclude), ...Object.entries(searchExclude)].filter(([, value]) => value === true).map(([key]) => key)]
        .flatMap(expandGlob);
      const uris = await this.catalog.list({ folder, exclude: custom, limit: this.limits.files + 1, cancellation: cancellation.token });
      if (!this.gate.current(request)) return;
      if (uris.length > this.limits.files) state.reasons.add(`文件扫描上限 ${this.limits.files}`);
      const dirty = new Map(this.catalog.documents().filter(document => document.isDirty).map(document => [uriKey(document.uri), document]));
      const all = [...new Map([...uris, ...[...dirty.values()].map(document => document.uri)].map(uri => [uriKey(uri), uri])).values()];
      const candidates = all.filter(uri => {
        const relative = relativeUriPath(folder.uri, uri); return relative !== undefined && !excluded(relative, this.patterns);
      }).sort((a, b) => uriKey(a).localeCompare(uriKey(b)));
      if (candidates.length > this.limits.files) { candidates.length = this.limits.files; state.reasons.add(`文件扫描上限 ${this.limits.files}`); }
      let at = 0, ownersAvailable = true, lastProgress = 0;
      const worker = async () => {
        while (at < candidates.length && !state.stop && this.gate.current(request)) {
          const uri = candidates[at++];
          try {
            const document = dirty.get(uriKey(uri)); let text;
            if (document) text = document.getText();
            else {
              if (vscode.workspace.fs.stat && (await vscode.workspace.fs.stat(uri)).size > this.limits.bytes) { state.skipped++; continue; }
              const raw = await vscode.workspace.fs.readFile(uri);
              if (!this.gate.current(request)) return;
              if (raw.byteLength > this.limits.bytes || raw.includes(0) && !((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff))) { state.skipped++; continue; }
              try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
              catch { text = (await vscode.workspace.openTextDocument(uri)).getText(); }
            }
            const bytes = Buffer.byteLength(text);
            if (bytes > this.limits.bytes) { state.skipped++; continue; }
            if (state.bytes + bytes > this.limits.totalBytes) { state.stop = true; state.reasons.add('总扫描字节数上限'); continue; }
            state.bytes += bytes;
            const remaining = this.limits.matches - state.rows.length;
            if (remaining <= 0) { state.stop = true; state.reasons.add(`匹配上限 ${this.limits.matches}`); continue; }
            const hits = findMatches(text, query, this.options, remaining);
            const rows = hits.map(hit => ({ ...hit, uri, range: new vscode.Range(hit.line, hit.start, hit.line, hit.end),
              id: String(++this.serial), path: relativeUriPath(folder.uri, uri), owner: '—' }));
            state.rows.push(...rows);
            if (state.rows.length >= this.limits.matches) { state.stop = true; state.reasons.add(`匹配上限 ${this.limits.matches}`); }
            if (hits.length && ownersAvailable) {
              let timer;
              try {
                const symbols = await Promise.race([this.symbols(uri), new Promise((resolve, reject) => {
                  timer = setTimeout(() => reject(new Error('scope timeout')), 1000);
                })]);
                for (const row of rows) row.owner = enclosingFunction(symbols, row.range.start)?.name || (symbols.length ? '文件级' : '—');
              } catch { ownersAvailable = false; } finally { clearTimeout(timer); }
            }
            state.scanned++;
          } catch { state.failed++; }
          if (!this.gate.current(request)) return;
          if (Date.now() - lastProgress > 100) {
            lastProgress = Date.now(); this.message = `正在检索：${state.scanned} 个文件，${state.rows.length} 处匹配`; this.changed();
          }
          await new Promise(resolve => setImmediate(resolve));
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      if (!this.gate.current(request)) return;
      this.rows = state.rows.sort((a, b) => uriKey(a.uri).localeCompare(uriKey(b.uri)) || a.line - b.line || a.start - b.start);
      this.stats = { files: new Set(this.rows.map(row => uriKey(row.uri))).size, scanned: state.scanned,
        skipped: state.skipped, failed: state.failed, reasons: [...state.reasons] };
      this.message = `${this.rows.length} 处匹配，${this.stats.files} 个文件` +
        (state.skipped ? ` · 跳过 ${state.skipped} 个二进制或过大文件` : '') + (state.failed ? ` · ${state.failed} 个文件读取失败` : '') +
        (state.reasons.size ? ` · 结果不完整：${[...state.reasons].join('、')}` : '');
    } catch (error) { if (this.gate.current(request)) { failure = error; this.message = `检索失败：${error.message}`; } }
    finally { if (this.gate.current(request)) { this.queryState = queryState.settle(this.queryState, queryResult(this.rows, 'none', failure ? 'error' : this.rows.length ? 'ready' : 'empty', String(request), failure ? [failure.message] : [])); this.changed(); } }
  }
  async validate(row) {
    if (this.busy || this.stale || !this.rows.includes(row)) return false;
    try {
      const document = await vscode.workspace.openTextDocument(row.uri);
      if (this.stale || !this.rows.includes(row) || row.line >= document.lineCount || document.lineAt(row.line).text !== row.lineText) {
        this.markStale(row.uri); return false;
      }
      return true;
    } catch { this.markStale(row.uri); return false; }
  }
  dispose() { this.gate.dispose(); this.cancellation?.cancel(); this.cancellation?.dispose(); this.disposables.forEach(item => item.dispose()); this.emitter.dispose(); }
}
module.exports = { TextLookup, findMatches, literalPattern, folderFor };
