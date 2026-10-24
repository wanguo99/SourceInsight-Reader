'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const { createAnchor, locateAnchor } = require('../domain/reading-anchor');
const { normalizeLocation, uniqueLocations } = require('../core');
const { t } = require('../i18n');

class ReaderTools {
  constructor(app) { this.app = app; this.state = app.context.workspaceState; }
  async document(value, language = 'json') {
    const document = await vscode.workspace.openTextDocument({ content: typeof value === 'string' ? value : JSON.stringify(value, null, 2), language });
    await vscode.window.showTextDocument(document, { preview: false });
    return document;
  }
  async diagnostics(exported = false) {
    const app = this.app, roots = vscode.workspace.workspaceFolders || [];
    const files = ['compile_commands.json', 'build/compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakePresets.json'];
    const build = await Promise.all(roots.map(async (root, at) => ({ root: `workspace-${at + 1}`,
      scheme: root.uri.scheme, files: await Promise.all(files.map(async name => {
        let timer;
        try { await Promise.race([vscode.workspace.fs.stat(vscode.Uri.joinPath(root.uri, name)), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('unavailable')), 1000); })]); return { name, present: true }; }
        catch { return { name, present: false }; } finally { clearTimeout(timer); }
      })) })));
    const extensions = ['llvm-vs-code-extensions.vscode-clangd', 'ms-vscode.cpptools', 'redhat.java', 'ms-python.vscode-pylance'].map(id => {
      const extension = vscode.extensions.getExtension(id); return { id, installed: Boolean(extension), active: Boolean(extension?.isActive), version: extension?.packageJSON.version };
    });
    const report = { schema: 1, version: require('../../package.json').version, vscode: vscode.version, platform: process.platform,
      remote: vscode.env.remoteName || 'local', trusted: vscode.workspace.isTrusted, generatedAt: new Date().toISOString(),
      navigationBackend: app.language.mode(), index: { enabled: app.localIndex.enabled(), phase: app.localIndex.phase,
        files: app.localIndex.summary?.files || 0, failures: app.localIndex.summary?.failures?.length || 0,
        syntaxErrors: app.localIndex.summary?.errors || 0, pending: app.localIndex.pending.size, generation: app.localIndex.revision },
      build, extensions, querySummary: [...app.language.queryStates.values()].map(({ status, provider, elapsedMs }) => ({ status, provider, elapsedMs })),
      queryCounters: app.language.queries?.snapshot(),
      notes: [t('本地 C 索引不求值条件编译。'), t('安装语言扩展不代表语义服务已就绪；检查语言扩展输出和编译数据库。'),
        t('导出不包含源码、路径、查询文本、笔记或编译参数；导出前仍请检查内容。')] };
    if (exported) {
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file('sourceinsight-diagnostics.json'), filters: { JSON: ['json'] } });
      if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(report, null, 2) + '\n'));
    } else await this.document(report);
    return report;
  }
  async keyboardPreset() {
    const choice = await vscode.window.showQuickPick([
      { label: t('保留 VS Code 快捷键'), value: false }, { label: t('启用 Source Insight 快捷键（含 F2）'), value: true }
    ], { placeHolder: t('选择键位预设；可在设置中分别修改') });
    if (!choice) return;
    const config = vscode.workspace.getConfiguration('sourceInsightReader');
    await config.update('sourceInsightKeys', choice.value, vscode.ConfigurationTarget.Workspace);
    await config.update('symbolHighlightUseF2', choice.value, vscode.ConfigurationTarget.Workspace);
  }
  capture(source) {
    const doc = this.app.catalog.document(source.uri);
    if (!doc) throw new Error(t('请先打开需要保存的位置'));
    return { uri: source.uri.toString(), name: source.name || vscode.workspace.asRelativePath(source.uri),
      anchor: createAnchor(doc.getText(), source.range.start.line, source.range.start.character) };
  }
  async resolve(saved) {
    const uri = vscode.Uri.parse(saved.uri);
    if (!this.app.catalog.accepts(uri)) throw new Error(t('保存的位置已被屏蔽或不在工作区内'));
    const doc = await vscode.workspace.openTextDocument(uri), resolved = locateAnchor(doc.getText(), saved.anchor);
    if (['missing', 'ambiguous'].includes(resolved.status)) throw new Error(t('位置已删除或存在多个相同候选，请重新定位'));
    return { uri, range: new vscode.Range(resolved.line, resolved.character, resolved.line, resolved.character), name: saved.name };
  }
  async addBookmark() {
    const source = this.app.navigation.source(); if (!source) return;
    const value = this.capture(source), note = await vscode.window.showInputBox({ prompt: t('书签笔记（仅保存在当前工作区的插件存储中）'), value: value.name, validateInput: value => value.length > 4000 ? t('笔记最多 4000 个字符') : undefined });
    if (note === undefined) return;
    const bookmarks = this.state.get('reader.bookmarks', []);
    if (bookmarks.length >= 1000) throw new Error(t('书签已达 1000 项，请先删除旧项'));
    await this.state.update('reader.bookmarks', [...bookmarks, { ...value, id: crypto.randomUUID(), note }]);
  }
  async bookmarks() {
    const values = this.state.get('reader.bookmarks', []);
    /** @type {any} */
    const saved = await vscode.window.showQuickPick(values.map(value => ({ label: value.note || value.name,
      description: `${vscode.workspace.asRelativePath(vscode.Uri.parse(value.uri))}:${value.anchor.line + 1}`, saved: value })), { placeHolder: t('选择书签') });
    if (!saved) return;
    const action = await vscode.window.showQuickPick([t('打开'), t('编辑笔记'), t('删除')]);
    if (action === t('打开')) return this.app.navigation.openTarget(await this.resolve(saved.saved));
    if (action === t('删除')) return this.state.update('reader.bookmarks', values.filter(value => value.id !== saved.saved.id));
    if (action === t('编辑笔记')) {
      const note = await vscode.window.showInputBox({ value: saved.saved.note, prompt: t('编辑笔记'), validateInput: value => value.length > 4000 ? t('笔记最多 4000 个字符') : undefined });
      if (note !== undefined) await this.state.update('reader.bookmarks', values.map(value => value.id === saved.saved.id ? { ...value, note } : value));
    }
  }
  async saveTask() {
    const source = this.app.navigation.source(); if (!source) return;
    const name = await vscode.window.showInputBox({ prompt: t('阅读任务名称'), validateInput: value => !value.trim() || value.length > 100 ? t('请输入 1–100 个字符') : undefined });
    if (!name) return;
    const capture = source => { try { return source && this.capture(source); } catch { return undefined; } };
    const task = { name, main: this.capture(source), context: capture(this.app.preview.current), contextLocked: this.app.preview.locked,
      relation: capture(this.app.relations.source), direction: this.app.relations.direction, relationLocked: this.app.relations.locked,
      symbolQuery: this.app.symbols.query, search: { query: this.app.textLookup.query, folder: this.app.textLookup.folder?.uri.toString(), options: this.app.textLookup.options } };
    await this.state.update('reader.tasks', [task, ...this.state.get('reader.tasks', []).filter(value => value.name !== name)].slice(0, 30));
  }
  async restoreTask() {
    /** @type {any} */
    const choice = await vscode.window.showQuickPick(this.state.get('reader.tasks', []).map(task => ({ label: task.name, task })), { placeHolder: t('恢复阅读任务（重新查询最新源码）') });
    if (!choice) return;
    const task = choice.task, main = await this.resolve(task.main), failures = [];
    // Resolve all optional targets first; an invalid anchor never becomes a clamped jump.
    const resolve = async value => { try { return value && await this.resolve(value); } catch (error) { failures.push(error.message); } };
    const preview = await resolve(task.context), relation = await resolve(task.relation);
    await this.app.navigation.openTarget(main); this.app.follow.cancel();
    this.app.symbols.query = task.symbolQuery || ''; this.app.symbols.refresh();
    this.app.preview.locked = false; if (preview) await this.app.preview.show(preview); this.app.preview.locked = Boolean(task.contextLocked && preview); this.app.preview.publish();
    this.app.relations.locked = false;
    if (relation) { this.app.relations.direction = task.direction || 'incoming'; await this.app.relations.setRoot(relation, { manual: true }); }
    this.app.relations.locked = Boolean(task.relationLocked && relation);
    if (task.search?.query) {
      const folder = this.app.textSession.roots().find(root => root.uri.toString() === task.search.folder);
      if (folder) await this.app.textLookup.search(task.search.query, folder, task.search.options);
    }
    if (failures.length) vscode.window.showWarningMessage(failures.join('; '));
  }
  async savedSearch(save = false) {
    const model = this.app.textLookup, values = this.state.get('reader.queries', []);
    if (save) {
      if (!model.query || !model.folder) return;
      const value = { query: model.query, folder: model.folder.uri.toString(), ...model.options };
      return this.state.update('reader.queries', [value, ...values.filter(item => JSON.stringify(item) !== JSON.stringify(value))].slice(0, 50));
    }
    /** @type {any} */
    const chosen = await vscode.window.showQuickPick(values.map(value => ({ label: value.query, description: `${value.regex ? 'RegExp ' : ''}${value.multiline ? 'Multiline ' : ''}${value.folder}`, value })), { placeHolder: t('打开保存的检索') });
    if (!chosen) return;
    const folder = this.app.textSession.roots().find(root => root.uri.toString() === chosen.value.folder);
    if (!folder) throw new Error(t('原检索范围已不可用，请重新选择范围'));
    this.app.searchResultsView.show('text'); await model.search(chosen.value.query, folder, chosen.value);
  }
  async explore() {
    const source = this.app.navigation.source(); if (!source) return;
    const choices = ['实现', '类型层次（语言服务）', '成员', '包含的文件', '包含此文件'].map((label, index) => ({ label: t(label), index }));
    const choice = await vscode.window.showQuickPick(choices, { placeHolder: t('选择关系；能力由当前语言服务或本地索引决定') }); if (!choice) return;
    let values = [];
    if (choice.index === 0) {
      const locations = await this.app.language.query('implementations', source.uri, () => vscode.commands.executeCommand('vscode.executeImplementationProvider', source.uri, source.range.start));
      values = uniqueLocations((locations || []).map(normalizeLocation)).filter(value => this.app.language.allowed(value.uri));
    } else if (choice.index === 1) {
      const commands = await vscode.commands.getCommands(true);
      if (!commands.includes('editor.showTypeHierarchy')) throw new Error(t('当前 VS Code 或语言服务未提供类型层次入口'));
      await this.app.navigation.openTarget(source); await vscode.commands.executeCommand('editor.showTypeHierarchy'); return;
    } else if (choice.index === 2) {
      const nodes = await this.app.language.symbols(source.uri);
      const contains = range => range.start.line <= source.range.start.line && range.end.line >= source.range.start.line;
      const descend = nodes => { const node = nodes.find(node => contains(node.range)); if (!node?.children?.length) return []; const inner = descend(node.children); return inner.length ? inner : node.children; };
      values = descend(nodes).map(node => ({ ...node, uri: node.uri || source.uri, range: node.selectionRange || node.range }));
    } else values = await this.app.localIndex.includeRelations(source.uri, choice.index === 4);
    if (!values.length) { vscode.window.showInformationMessage(t('当前范围没有结果；请检查能力诊断和语言服务配置')); return; }
    /** @type {any} */
    const chosen = await vscode.window.showQuickPick(values.map(value => ({ label: value.name || vscode.workspace.asRelativePath(value.uri),
      description: `${vscode.workspace.asRelativePath(value.uri)}:${value.range.start.line + 1}`, value })), { placeHolder: t('选择结果以预览'), onDidSelectItem: item => { if (typeof item === 'object' && 'value' in item) this.app.run(() => this.app.preview.show(item.value)); } });
    if (chosen) await this.app.preview.show(chosen.value);
  }
}
module.exports = { ReaderTools };
