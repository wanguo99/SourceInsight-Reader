'use strict';
const vscode = require('vscode');
const { ViewChannel } = require('./infrastructure/view-channel');
const { options, defaultValue, readValue, applyChanges } = require('./appearance-options');
const { featureOptions, describeFeature, parseFeatureChanges } = require('./feature-options');

class AppearancePanel {
  constructor(extensionUri, fail) { this.extensionUri = extensionUri; this.fail = fail; this.queue = Promise.resolve(); this.activeTab = 'features'; }
  settings(target) {
    const read = (config, key, fallback) => target ? config.inspect(key)?.[target === vscode.ConfigurationTarget.Global ? 'globalValue' : 'workspaceValue'] ?? fallback : config.get(key, fallback);
    const editor = vscode.workspace.getConfiguration('editor');
    return { semantic: read(editor, 'semanticTokenColorCustomizations', {}), textmate: read(editor, 'tokenColorCustomizations', {}),
      colors: read(vscode.workspace.getConfiguration('workbench'), 'colorCustomizations', {}),
      icon: read(vscode.workspace.getConfiguration('workbench'), 'productIconTheme', undefined),
      panes: read(vscode.workspace.getConfiguration('sourceInsightReader'), 'appearance.panes', {}),
      editor: Object.fromEntries(options.filter(option => option.kind === 'editor').map(option => [option.key, read(editor, option.key, undefined)])) };
  }
  show(tab = 'features') {
    this.activeTab = tab === 'appearance' ? 'appearance' : 'features';
    if (this.panel) { this.panel.reveal(); this.channel?.postMessage({ scope: 'settingsTab', tab: this.activeTab }); return; }
    this.panel = vscode.window.createWebviewPanel('sourceInsightReader.appearance', 'SourceInsight-Reader 设置', vscode.ViewColumn.One, { enableScripts: true });
    this.channel = new ViewChannel(this.panel.webview, this.extensionUri, ['ready', 'settingsTab', 'settingsSave', 'settingsSaveReload', 'appearanceSave'], message => {
      this.queue = this.queue.catch(() => {}).then(() => this.handle(message)); return this.queue;
    }, this.fail);
    this.panel.webview.options = { enableScripts: true, localResourceRoots: this.channel.roots() };
    this.panel.webview.html = this.channel.document({ title: 'SourceInsight-Reader 设置', styles: ['media/appearance-panel.css'], scripts: ['media/appearance-panel.js'], body: `
<h1>SourceInsight-Reader 设置</h1>
<div id="settings-tabs" role="tablist" aria-label="设置分类"><button id="tab-features" role="tab" aria-controls="settings-content" aria-selected="true">功能设置</button><button id="tab-appearance" role="tab" aria-controls="settings-content" aria-selected="false" tabindex="-1">外观设置</button></div>
<p id="settings-description"></p>
<p>只保存修改项，切换标签保留未保存修改；工作区设置优先于用户设置。点击保存立即应用，需要重新加载扩展时可选择保存并重载窗口。</p>
<nav><label>保存到 <select id="target"><option value="workspace">当前工作区</option><option value="user">用户设置（所有工程）</option></select></label>
<button id="save">保存并应用</button><button id="save-reload">保存并重载窗口</button><button id="defaults">当前页默认值</button><button id="reload" title="放弃未保存修改并重新读取配置">放弃修改并重新读取</button><span id="status" role="status" aria-live="polite"></span></nav>
<main id="settings-content" role="tabpanel" aria-labelledby="tab-features"><div class="browse"><input id="filter" type="search" placeholder="筛选设置" aria-label="筛选设置"><div id="groups" aria-label="当前标签页设置分类"></div></div><div id="options"></div></main>` });
    this.closed = this.panel.onDidDispose(() => { this.channel?.dispose(); this.channel = undefined; this.panel = undefined; this.closed?.dispose(); });
    this.publish();
  }
  publish(status = '') {
    const settings = this.settings();
    const config = vscode.workspace.getConfiguration('sourceInsightReader');
    return this.channel?.postMessage({ scope: 'appearanceOptions', status, tab: this.activeTab, hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length),
      options: options.map(option => ({ id: option.id, label: option.label, group: option.group, type: option.type,
        tab: 'appearance', choices: option.choices, value: String(readValue(option, settings) ?? ''), default: String(defaultValue(option) ?? '') }))
        .concat(featureOptions.map(option => describeFeature(option, config.get(option.key, option.schema.default)))) });
  }
  async handle(message) {
    if (message.action === 'ready') return this.publish();
    if (message.action === 'settingsTab') { if (['features', 'appearance'].includes(message.mode)) this.activeTab = message.mode; return; }
    try {
      const changes = JSON.parse(message.query);
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('设置格式错误');
      if (!['user', 'workspace'].includes(message.mode)) throw new Error('请选择保存作用域');
      const target = message.mode === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
      if (message.mode !== 'user' && !vscode.workspace.workspaceFolders?.length) throw new Error('请先打开工作区或选择用户设置');
      // Read at save time so concurrent edits in Settings are preserved.
      const before = this.settings(target);
      const features = parseFeatureChanges(Object.fromEntries(Object.entries(changes).filter(([id]) => id.startsWith('feature.'))));
      const after = applyChanges(before, Object.fromEntries(Object.entries(changes).filter(([id]) => !id.startsWith('feature.'))));
      const editor = vscode.workspace.getConfiguration('editor'), workbench = vscode.workspace.getConfiguration('workbench');
      /** @type {Array<[string, import('vscode').WorkspaceConfiguration, string]>} */
      const updates = [['semantic', editor, 'semanticTokenColorCustomizations'], ['textmate', editor, 'tokenColorCustomizations'],
        ['colors', workbench, 'colorCustomizations'], ['panes', vscode.workspace.getConfiguration('sourceInsightReader'), 'appearance.panes'], ['icon', workbench, 'productIconTheme']];
      for (const [key, config, field] of updates) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) await config.update(field, after[key], target);
      }
      for (const [key, value] of Object.entries(after.editor)) if (before.editor[key] !== value) await editor.update(key, value, target);
      const config = vscode.workspace.getConfiguration('sourceInsightReader');
      for (const [key, value] of features) {
        const previous = config.inspect(key)?.[target === vscode.ConfigurationTarget.Global ? 'globalValue' : 'workspaceValue'];
        if (JSON.stringify(previous) !== JSON.stringify(value)) await config.update(key, value, target);
      }
      await this.publish(message.mode === 'user' ? '已保存到用户设置；当前工作区的同名设置仍优先' : '已保存，界面已更新');
      if (message.action === 'settingsSaveReload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      await this.channel?.postMessage({ scope: 'appearanceError', status: `保存失败：${error.message}；部分设置可能已生效，未保存修改仍保留，可重试` });
      return { error: error.message };
    }
  }
  dispose() { this.panel?.dispose(); this.channel?.dispose(); this.closed?.dispose(); }
}
module.exports = { AppearancePanel };
