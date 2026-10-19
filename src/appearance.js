'use strict';
const vscode = require('vscode');
const THEME_ID = 'Source Insight Inspired Source Insight';
const SNAPSHOT_KEY = 'appearance.previousTheme';

class ReadingAppearance {
  constructor(context, fail) {
    this.context = context; this.fail = fail; this.queue = Promise.resolve(); this.updating = false; this.disposed = false;
    this.subscription = vscode.workspace.onDidChangeConfiguration(event => {
      if (this.updating || this.disposed) return;
      if (event.affectsConfiguration('sourceInsightInspired.appearance')) this.enqueue(() => this.apply(this.mode()));
      else if (event.affectsConfiguration('workbench.colorTheme') && this.mode() === 'sourceInsight' && this.theme() !== THEME_ID) {
        // Respect a theme the user picked outside this extension.
        this.enqueue(async () => {
          if (this.mode() !== 'sourceInsight' || this.theme() === THEME_ID) return;
          await this.setPreference('vscode'); await context.workspaceState.update(SNAPSHOT_KEY, undefined);
        });
      }
    });
    this.enqueue(() => this.apply(this.mode()));
  }
  mode() { return vscode.workspace.getConfiguration('sourceInsightInspired').get('appearance', 'vscode'); }
  theme() { return vscode.workspace.getConfiguration('workbench').get('colorTheme', ''); }
  enqueue(action) {
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      this.updating = true;
      try { await action(); } finally { this.updating = false; }
    }).catch(this.fail);
    return this.queue;
  }
  target() { return vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global; }
  async setPreference(mode) {
    if (this.mode() !== mode) await vscode.workspace.getConfiguration('sourceInsightInspired').update('appearance', mode, this.target());
  }
  async apply(mode) {
    const workbench = vscode.workspace.getConfiguration('workbench');
    const previous = this.context.workspaceState.get(SNAPSHOT_KEY);
    if (mode === 'sourceInsight') {
      if (this.theme() !== THEME_ID) {
        const target = this.target();
        const inspected = workbench.inspect('colorTheme');
        const value = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
        await this.context.workspaceState.update(SNAPSHOT_KEY, { target, hadValue: value !== undefined, value });
        await workbench.update('colorTheme', THEME_ID, target);
      }
    } else if (previous) {
      if (this.theme() === THEME_ID) await workbench.update('colorTheme', previous.hadValue ? previous.value : undefined, previous.target);
      await this.context.workspaceState.update(SNAPSHOT_KEY, undefined);
    }
  }
  async choose() {
    const choice = await vscode.window.showQuickPick([
      { label: '使用 VS Code 主题', value: 'vscode', description: '保留当前主题，或恢复切换前的主题' },
      { label: '使用 Source Insight 自定义主题', value: 'sourceInsight', description: '依据提供的 XML：浅绿背景、紫色注释、红色数字、深蓝声明' }
    ], { placeHolder: '选择 Source Insight Inspired 阅读主题', ignoreFocusOut: true });
    if (!choice) return;
    await this.enqueue(async () => {
      await this.setPreference(choice.value); await this.apply(choice.value);
      if (choice.value === 'vscode' && this.theme() === THEME_ID) await vscode.commands.executeCommand('workbench.action.selectTheme');
    });
  }
  dispose() { this.disposed = true; this.subscription.dispose(); }
}
module.exports = { ReadingAppearance, THEME_ID };
