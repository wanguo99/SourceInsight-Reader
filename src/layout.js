'use strict';
const vscode = require('vscode');
const SNAPSHOT = 'layout.previousSidebar';
const APPLIED = 'layout.sourceInsightApplied';

class ReadingLayout {
  constructor(context) { this.context = context; }
  target() { return vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global; }
  mode() { return vscode.workspace.getConfiguration('sourceReader').get('layout', 'sourceInsight'); }
  async apply() {
    const workbench = vscode.workspace.getConfiguration('workbench');
    if (!this.context.workspaceState.get(SNAPSHOT)) {
      const target = this.target(), inspected = workbench.inspect?.('sideBar.location');
      const value = inspected ? target === vscode.ConfigurationTarget.Workspace ? inspected.workspaceValue : inspected.globalValue
        : workbench.get('sideBar.location');
      await this.context.workspaceState.update(SNAPSHOT, { target, hadValue: value !== undefined, value });
    }
    // Explorer stays in the primary sidebar; the extension uses the opposite sidebar.
    if (workbench.get('sideBar.location', String('left')) !== 'right') await workbench.update('sideBar.location', 'right', this.target());
    await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    await vscode.commands.executeCommand('workbench.action.alignPanelJustify');
    const config = vscode.workspace.getConfiguration('sourceReader');
    if (this.mode() !== 'sourceInsight') await config.update('layout', 'sourceInsight', this.target());
    await this.context.workspaceState.update(APPLIED, true);
    await this.show();
    await vscode.commands.executeCommand('sourceReader.context.focus', { preserveFocus: true });
  }
  async show() {
    const editor = vscode.window.activeTextEditor;
    if (this.mode() === 'sourceInsight') await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
    await vscode.commands.executeCommand('sourceReader.symbols.focus', { preserveFocus: true });
    if (editor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }
  async initialize() {
    if (this.mode() === 'sourceInsight' && !this.context.workspaceState.get(APPLIED)) await this.apply();
    else await this.show();
  }
  async restore() {
    await vscode.workspace.getConfiguration('sourceReader').update('layout', 'preserve', this.target());
    const previous = this.context.workspaceState.get(SNAPSHOT);
    if (previous) {
      const workbench = vscode.workspace.getConfiguration('workbench');
      // Preserve a newer manual sidebar choice.
      if (workbench.get('sideBar.location', String('left')) === 'right') await workbench.update('sideBar.location', previous.hadValue ? previous.value : undefined, previous.target);
      await this.context.workspaceState.update(SNAPSHOT, undefined);
    }
    await this.context.workspaceState.update(APPLIED, undefined);
  }
}
module.exports = { ReadingLayout };
