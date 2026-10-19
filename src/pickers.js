'use strict';
const vscode = require('vscode');
const { RequestGate, globRegex } = require('./core');
const { relativeUriPath } = require('./resources');

class ReadingPickers {
  constructor(language, open, preview, report) {
    this.language = language; this.open = open; this.preview = preview; this.report = report;
  }
  create(title) {
    this.close();
    /** @type {import('vscode').QuickPick<import('vscode').QuickPickItem & {target: {uri: import('vscode').Uri, range: import('vscode').Range, name?: string, mode?: string}}>} */
    const picker = vscode.window.createQuickPick();
    const gate = new RequestGate();
    const disposables = [];
    picker.title = title; picker.matchOnDescription = true;
    let closed = false;
    const session = { picker, gate, timer: undefined, dispose: () => {
      if (closed) return;
      closed = true;
      clearTimeout(session.timer); gate.dispose(); disposables.forEach(item => item.dispose()); picker.dispose();
      if (this.active === session) this.active = undefined;
    } };
    this.active = session;
    disposables.push(picker.onDidChangeActive(items => {
      if (items[0]?.target) this.preview(items[0].target).catch(this.report);
    }), picker.onDidAccept(() => {
      const chosen = picker.selectedItems[0];
      if (chosen?.target) { picker.hide(); this.open(chosen.target).catch(this.report); }
    }), picker.onDidHide(() => session.dispose()));
    picker.show(); return session;
  }
  async files() {
    const session = this.create('工程文件 · 输入名称筛选，选择预览，Enter 打开');
    session.picker.busy = true;
    try {
      const files = await vscode.workspace.findFiles('**/*', undefined, 10001);
      if (!session.gate.current(session.gate.version)) return;
      const matches = files.filter(uri => {
        const folder = (vscode.workspace.workspaceFolders || []).filter(root => relativeUriPath(root.uri, uri) !== undefined)
          .sort((a, b) => b.uri.path.length - a.uri.path.length)[0];
        if (!folder) return false;
        const relative = relativeUriPath(folder.uri, uri);
        const config = vscode.workspace.getConfiguration('sourceInsightReader', uri);
        const excludes = config.get('files.exclude', []).map(globRegex);
        const includes = config.get('files.include', []).map(globRegex);
        // A directory exclusion must also exclude all descendants in the flat picker.
        const prefixes = relative.split('/').map((_, index, segments) => segments.slice(0, index + 1).join('/'));
        return !excludes.some(regex => prefixes.some(prefix => regex.test(prefix))) &&
          (!includes.length || includes.some(regex => regex.test(relative)));
      });
      session.picker.items = matches.slice(0, 10000).map(uri => ({
        label: uri.path.split('/').at(-1), description: vscode.workspace.asRelativePath(uri),
        target: { uri, range: new vscode.Range(0, 0, 0, 0), mode: '文件预览' }
      }));
      session.picker.placeholder = files.length > 10000 ? '仅扫描前 10000 个文件；更大工程可使用 VS Code 原生文件搜索' : `${matches.length} 个文件`;
    } catch (error) { if (this.active === session) this.report(error); }
    finally { if (this.active === session) session.picker.busy = false; }
  }
  symbols(initial = '') {
    const session = this.create('全局符号 · 输入名称，选择预览，Enter 打开');
    const update = query => {
      clearTimeout(session.timer);
      const request = session.gate.next();
      session.picker.items = [];
      session.picker.busy = Boolean(query.trim());
      if (!query.trim()) { session.picker.placeholder = '输入符号名，复用当前语言服务的工作区索引'; return; }
      session.timer = setTimeout(async () => {
        try {
          const symbols = await this.language.workspaceSymbols(query.trim());
          if (!session.gate.current(request)) return;
          session.picker.items = symbols.filter(symbol => symbol.location?.range).slice(0, 1000).map(symbol => ({
            label: symbol.name, description: `${symbol.containerName || ''} · ${vscode.workspace.asRelativePath(symbol.location.uri)}`,
            target: { ...symbol.location, name: symbol.name, mode: '符号定义' }
          }));
          session.picker.placeholder = symbols.length > 1000 ? '展示前 1000 个符号，请缩小查询范围' : `${session.picker.items.length} 个符号`;
        } catch (error) { if (session.gate.current(request)) this.report(error); }
        finally { if (session.gate.current(request)) session.picker.busy = false; }
      }, 200);
    };
    const change = session.picker.onDidChangeValue(update);
    const dispose = session.dispose;
    session.dispose = () => { change.dispose(); dispose(); };
    session.picker.value = initial;
    update(initial);
  }
  close() { this.active?.picker.hide(); }
  dispose() { this.close(); }
}

module.exports = { ReadingPickers };
