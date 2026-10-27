'use strict';
const vscode = require('vscode');
const { relativeUriPath, uriKey } = require('../resources');
const { ViewChannel } = require('../infrastructure/view-channel');
const { t } = require('../i18n');
const PAGE = 200;

class ProjectSourcesPanel {
  constructor(context, catalog, fail, onStart = async () => {}) {
    this.onStart = onStart;
    this.context = context; this.catalog = catalog; this.fail = fail; this.queue = Promise.resolve(); this.serial = 0;
    this.nodes = new Map(); this.byKey = new Map(); this.children = new Map(); this.expanded = new Set(); this.selected = new Map();
    this.configuration = vscode.workspace.onDidChangeConfiguration(event => {
      if (!this.panel || this.saving || !event.affectsConfiguration('sourceInsightReader.projectSources') || this.baseline === JSON.stringify(this.catalog.scope.selection())) return;
      this.conflict = true; void this.publish('工程配置已在其他位置改变，请重新读取后再保存');
    });
    this.folders = vscode.workspace.onDidChangeWorkspaceFolders(() => { this.conflict = true; void this.publish('工作区已改变，请重新读取后再保存'); });
  }
  show() {
    if (this.panel) { this.panel.reveal(); return; }
    this.panel = vscode.window.createWebviewPanel('sourceInsightReader.projectSources', t('工程文件管理'), vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true });
    this.channel = new ViewChannel(this.panel.webview, this.context.extensionUri,
      ['ready', 'expand', 'more', 'toggle', 'remove', 'range', 'clear', 'whole', 'mode', 'chooseDatabase', 'addMapping', 'removeMapping', 'start', 'reload', 'save', 'close'], message => {
        this.queue = this.queue.catch(() => {}).then(() => this.handle(message)); return this.queue;
      }, this.fail);
    this.panel.webview.options = { enableScripts: true, localResourceRoots: this.channel.roots() };
    this.panel.webview.html = this.channel.document({ title: '工程文件管理', styles: ['media/project-sources.css'], scripts: ['media/project-sources.js'], body: `
<header><h1>工程文件管理</h1><p>选择索引模式和范围；保存只保留配置，点击开始索引后生效。</p></header>
<fieldset id="index-mode"><legend>索引方式</legend><label><input id="mode-compilation" name="mode" type="radio" value="compilation">compile_commands.json</label><label><input id="mode-selected" name="mode" type="radio" value="selected">已导入文件</label><label><input id="mode-workspace" name="mode" type="radio" value="workspace">整个工程</label></fieldset>
<div id="compilation-options" hidden><button id="choose-database">选择编译数据库</button><span id="database-path"></span><p>Buildroot / 独立输出目录：将编译记录中的构建目录映射到当前源码目录。只读取源码中的对应文件；缺失的生成文件会报告在日志中。</p><button id="add-mapping">添加构建目录 → 源码目录映射</button><div id="path-mappings"></div></div>
<nav><button id="reload">放弃修改并重新读取</button><button id="clear">清空选择</button></nav>
<p class="hint" id="selection-hint">勾选目录包含全部子项；按住 Shift 单击可连续勾选或取消。只选部分子项时，先取消父目录勾选。屏蔽规则仍然优先。</p>
<p id="compilation-summary" hidden>点击“开始索引”后读取编译数据库，发现源文件及工程内可解析的头文件依赖。不会执行编译命令。</p>
<main id="source-picker"><section aria-labelledby="tree-heading"><h2 id="tree-heading">工作区文件</h2><p>展开目录以加载内容</p><div id="tree" role="tree" aria-label="可选目录和文件"></div></section>
<section aria-labelledby="selection-heading"><h2 id="selection-heading">已选条目</h2><p id="summary"></p><div id="selected"></div></section></main>
<footer><span id="status" role="status" aria-live="polite"></span><button id="save">保存配置</button><button id="start" class="primary">开始索引</button><button id="close" title="关闭后丢弃未保存的选择">关闭</button></footer>` });
    this.closed = this.panel.onDidDispose(() => { this.channel?.dispose(); this.channel = undefined; this.panel = undefined; this.nodes.clear(); this.byKey.clear(); this.children.clear(); this.closed?.dispose(); });
    this.queue = this.queue.catch(() => {}).then(() => this.reload());
  }
  node(uri, directory, name, parent) {
    const key = uriKey(uri);
    const existing = this.byKey.get(key);
    if (existing) { if (parent !== undefined) { existing.parent = parent; existing.name = name; } return existing; }
    const node = { id: String(++this.serial), key, uri, directory, name, parent };
    this.nodes.set(node.id, node); this.byKey.set(key, node); return node;
  }
  workspaceKey() { return JSON.stringify((vscode.workspace.workspaceFolders || []).map(root => uriKey(root.uri))); }
  async reload() {
    this.nodes.clear(); this.byKey.clear(); this.children.clear(); this.expanded.clear(); this.selected.clear(); this.rangeAnchors = {}; this.conflict = false;
    const selection = this.catalog.scope.selection();
    this.baseline = JSON.stringify(selection); this.workspace = this.workspaceKey(); this.mode = selection.mode; this.whole = selection.mode === 'workspace';
    this.compilationDatabase = selection.compilationDatabase || '';
    this.pathMappings = (selection.pathMappings || []).map(item => ({ ...item }));
    this.roots = (vscode.workspace.workspaceFolders || []).map(root => this.node(root.uri, true, root.name, undefined));
    const scope = this.catalog.scope.snapshot();
    if (scope.error) return this.publish(scope.error);
    for (const [values, directory] of [[this.catalog.scope.resolve(selection.directories), true], [this.catalog.scope.resolve(selection.files, false), false]]) for (const entry of values) {
      const node = this.node(entry.uri, directory, entry.name, undefined); this.selected.set(node.key, node);
    }
    this.dirty = false;
    await this.publish('保存配置不会启动索引；点击开始索引后生效');
  }
  inside(uri) { return (vscode.workspace.workspaceFolders || []).some(root => relativeUriPath(root.uri, uri) !== undefined); }
  parentSelection(node) { return [...this.selected.values()].find(value => value.directory && value.key !== node.key && relativeUriPath(value.uri, node.uri) !== undefined); }
  async expand(node, more = false) {
    const channel = this.channel;
    if (!node?.directory || !this.inside(node.uri)) return;
    if (!more && this.expanded.has(node.key)) { this.expanded.delete(node.key); return; }
    const previous = this.children.get(node.key);
    if (previous && !more) { this.expanded.add(node.key); return; }
    // Read just one directory. Never recursively enumerate the project on open.
    const entries = (await vscode.workspace.fs.readDirectory(node.uri)).filter(([name, type]) =>
      name !== '.' && name !== '..' && !/[\\/]/.test(name) && !(type & vscode.FileType.SymbolicLink) && (type & (vscode.FileType.Directory | vscode.FileType.File)))
      .sort((a, b) => Number(Boolean(b[1] & vscode.FileType.Directory)) - Number(Boolean(a[1] & vscode.FileType.Directory)) || a[0].localeCompare(b[0]));
    if (!this.panel || channel !== this.channel) return;
    if (this.nodes.size >= 10000) throw new Error('已加载条目较多，请重新读取后展开所需目录');
    const count = (previous?.count || 0) + PAGE;
    const nodes = entries.slice(0, count).map(([name, type]) => this.node(vscode.Uri.joinPath(node.uri, name), Boolean(type & vscode.FileType.Directory), name, node.key));
    this.children.set(node.key, { nodes, count, more: entries.length > count }); this.expanded.add(node.key);
  }
  toggle(node, checked) {
    if (!node || this.mode !== 'selected' || !this.inside(node.uri) || this.parentSelection(node)) return;
    if (checked) {
      if (node.directory) for (const [key, item] of this.selected) if (relativeUriPath(node.uri, item.uri) !== undefined) this.selected.delete(key);
      this.selected.set(node.key, node);
    } else this.selected.delete(node.key);
    this.dirty = true;
  }
  rememberAnchor(mode, node) {
    const rows = mode === 'tree' ? this.visibleTree : this.visibleSelected;
    if (!node || !rows?.some(row => row.id === node.id && !row.disabled && !row.more)) return;
    this.rangeAnchors[mode] = { id: node.id, order: rows.filter(row => !row.more).map(row => row.id) };
  }
  removeSelection(node) {
    if (!node) return;
    if (this.whole && this.roots.some(root => root.key === node.key)) {
      this.whole = false; this.mode = 'selected';
      for (const root of this.roots) this.selected.set(root.key, root);
    }
    if (this.selected.delete(node.key)) this.dirty = true;
  }
  selectRange(mode, id, checked) {
    if (!['tree', 'selected'].includes(mode) || this.mode === 'compilation' || mode === 'tree' && this.mode !== 'selected' || mode === 'selected' && checked) return;
    const rows = mode === 'tree' ? this.visibleTree : this.visibleSelected;
    const current = new Map((rows || []).filter(row => !row.more).map(row => [row.id, row]));
    if (!current.has(id) || current.get(id).disabled) return;
    const anchor = this.rangeAnchors[mode];
    // The right pane removes unchecked rows immediately. Keep the original
    // order so the last removed checkbox remains a usable Shift anchor.
    const order = mode === 'selected' && anchor ? anchor.order : [...current.keys()];
    const from = anchor ? order.indexOf(anchor.id) : -1, to = order.indexOf(id);
    const valid = from >= 0 && to >= 0;
    const ids = valid ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
    if (!valid) this.rememberAnchor(mode, this.nodes.get(id));
    for (const target of ids) {
      if (!current.has(target) || current.get(target).disabled) continue;
      if (mode === 'tree') this.toggle(this.nodes.get(target), checked);
      else this.removeSelection(this.nodes.get(target));
    }
  }
  selection() {
    const folders = vscode.workspace.workspaceFolders || [];
    const value = node => folders.length === 1 ? relativeUriPath(folders[0].uri, node.uri) || '.' : node.uri.toString();
    return { mode: this.mode, ...(this.pathMappings.length ? { pathMappings: this.pathMappings } : {}), directories: [...this.selected.values()].filter(node => node.directory).map(value),
      files: [...this.selected.values()].filter(node => !node.directory).map(value), ...(this.compilationDatabase ? { compilationDatabase: this.compilationDatabase } : {}) };
  }
  async save() {
    if (!this.roots?.length) throw new Error('请先打开工程文件夹，再导入文件。');
    if (this.mode === 'compilation' && !this.compilationDatabase) throw new Error('请先选择 compile_commands.json');
    if (this.conflict || this.workspace !== this.workspaceKey() || this.baseline !== JSON.stringify(this.catalog.scope.selection()))
      throw new Error('工程配置已在其他位置改变，请重新读取后再保存');
    for (const node of this.mode === 'selected' ? this.selected.values() : []) {
      if (!this.inside(node.uri)) throw new Error('所选路径不在当前工作区内');
      const stat = await vscode.workspace.fs.stat(node.uri);
      if (!(stat.type & (node.directory ? vscode.FileType.Directory : vscode.FileType.File))) throw new Error('所选路径已不存在或类型改变：' + node.uri.path);
    }
    if (!this.panel) return;
    // Recheck after asynchronous filesystem validation before the atomic update.
    if (this.workspace !== this.workspaceKey() || this.baseline !== JSON.stringify(this.catalog.scope.selection())) throw new Error('工程配置已改变，请重新读取后再保存');
    this.saving = true;
    try {
      await vscode.workspace.getConfiguration('sourceInsightReader').update('projectSources', this.selection(), vscode.ConfigurationTarget.Workspace);
      this.baseline = JSON.stringify(this.catalog.scope.selection()); this.dirty = false;
    } finally { this.saving = false; }
  }
  async handle(message) {
    if (!this.panel) return;
    if (this.starting && !['ready', 'close'].includes(message.action)) return this.publish('索引处理中，请等待完成后再修改配置');
    try {
      const node = this.nodes.get(message.id);
      if (message.action === 'ready') return this.publish();
      if (message.action === 'reload') return this.reload();
      if (message.action === 'close') { this.panel.dispose(); return; }
      if (message.action === 'addMapping') {
        if (this.pathMappings.length >= 32) throw new Error('最多支持 32 项路径映射');
        const build = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: t('选择编译数据库中记录的构建目录') });
        if (!build?.[0]) return this.publish();
        const source = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: this.roots?.[0]?.uri, title: t('选择对应的工作区源码目录') });
        if (!source?.[0]) return this.publish();
        if (build[0].scheme !== 'file' || source[0].scheme !== 'file' || !this.inside(source[0])) throw new Error('请选择当前扩展宿主的目录，映射目标必须位于工作区内');
        const item = { from: build[0].fsPath, to: source[0].fsPath };
        this.pathMappings = this.pathMappings.filter(mapping => mapping.from !== item.from);
        this.pathMappings.push(item); this.dirty = true;
      }
      if (message.action === 'removeMapping' && /^\d+$/.test(message.id) && Number(message.id) < this.pathMappings.length) {
        this.pathMappings.splice(Number(message.id), 1); this.dirty = true;
      }
      if (message.action === 'chooseDatabase') {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] },
          defaultUri: this.compilationDatabase ? vscode.Uri.parse(this.compilationDatabase) : this.roots?.[0]?.uri, title: t('选择 compile_commands.json') });
        if (picked?.[0]) { if (picked[0].scheme !== 'file') throw new Error('请选择当前扩展宿主上的编译数据库'); this.compilationDatabase = picked[0].toString(); this.dirty = true; }
      }
      if (message.action === 'mode' && ['selected', 'workspace', 'compilation'].includes(message.mode)) { this.mode = message.mode; this.whole = message.mode === 'workspace'; this.rangeAnchors = {}; this.dirty = true; }
      if (message.action === 'expand' || message.action === 'more') await this.expand(node, message.action === 'more');
      if (message.action === 'toggle' && typeof message.type === 'boolean') { this.rememberAnchor('tree', node); this.toggle(node, message.type); }
      if (message.action === 'range' && typeof message.type === 'boolean') this.selectRange(message.mode, message.id, message.type);
      if (message.action === 'remove' && node) { this.rememberAnchor('selected', node); this.removeSelection(node); }
      if (message.action === 'clear' && this.mode !== 'selected') return;
      if (message.action === 'clear' || message.action === 'whole') {
        this.rangeAnchors = {}; this.selected.clear(); this.whole = message.action === 'whole' && message.type === true; this.mode = this.whole ? 'workspace' : 'selected'; this.dirty = true;
      }
      if (message.action === 'save') { await this.save(); return this.publish('已保存配置；点击“开始索引”后创建索引'); }
      if (message.action === 'start') {
        if (this.starting) return;
        await this.save(); this.starting = true; await this.publish('正在启动索引…');
        void this.onStart().then(async () => {
          this.starting = false;
          const compiled = this.catalog.scope.compilation;
          await this.publish(this.conflict || this.baseline !== JSON.stringify(this.catalog.scope.selection()) ? '索引配置已改变，请重新读取并开始索引' : this.mode === 'compilation' && compiled
            ? `索引已更新：${compiled.sources} 条编译命令（映射 ${compiled.mappedSources || 0} 项，源码缺失 ${compiled.missingSources || 0} 项），${compiled.files.length} 个文件；工作区外 ${compiled.outside} 项，无效 ${compiled.invalid} 项${compiled.missing.length ? '；部分头文件未找到或位于工程外，请查看日志中的 compilationSources' : ''}` : '索引已更新');
        }, error => { this.starting = false; return this.publish(error.message); });
        return;
      }
      return this.publish();
    } catch (error) { return this.publish(error.message); }
  }
  publish(status = '') {
    if (!this.panel) return;
    const rows = [];
    const walk = (nodes, depth) => { for (const node of nodes) {
      const inherited = this.whole || Boolean(this.parentSelection(node));
      rows.push({ id: node.id, name: node.name, path: node.uri.path, directory: node.directory, depth, checked: inherited || this.selected.has(node.key), disabled: inherited || this.mode === 'compilation',
        partial: !inherited && !this.selected.has(node.key) && [...this.selected.values()].some(item => relativeUriPath(node.uri, item.uri) !== undefined), expanded: this.expanded.has(node.key) });
      if (this.expanded.has(node.key)) { const children = this.children.get(node.key); if (children) { walk(children.nodes, depth + 1); if (children.more) rows.push({ id: node.id, more: true, depth: depth + 1 }); } }
    } };
    walk(this.roots || [], 0);
    this.visibleTree = rows;
    this.visibleSelected = (this.whole ? this.roots || [] : [...this.selected.values()]).map(node => {
      const root = (this.roots || []).find(root => relativeUriPath(root.uri, node.uri) !== undefined);
      const relative = root && relativeUriPath(root.uri, node.uri);
      return { id: node.id, path: node.uri.path, label: root ? (this.roots.length > 1 ? root.name + (relative ? '/' + relative : '') : relative || root.name) : node.name, directory: node.directory };
    });
    return this.channel?.postMessage({ scope: 'projectSources', rows, selected: this.visibleSelected,
      mode: this.mode, starting: Boolean(this.starting), compilationDatabase: this.compilationDatabase, databaseDisplay: this.compilationDatabase?.startsWith('file:') ? vscode.Uri.parse(this.compilationDatabase).fsPath : this.compilationDatabase, pathMappings: this.pathMappings, whole: this.whole, dirty: this.dirty, status: status || (this.dirty ? '尚未保存' : '保存配置不会启动索引；点击开始索引后生效') });
  }
  dispose() { this.configuration.dispose(); this.folders.dispose(); this.panel?.dispose(); this.channel?.dispose(); this.closed?.dispose(); }
}
module.exports = { ProjectSourcesPanel };
