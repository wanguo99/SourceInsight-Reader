'use strict';
const vscode = require('vscode');
const SNAPSHOT = 'layout.previousSidebar';
const APPLIED = 'layout.sourceInsightApplied';

class ReadingLayout {
  constructor(context) { this.context = context; }
  target() { return vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global; }
  mode() { return vscode.workspace.getConfiguration('sourceInsightInspired').get('layout', 'sourceInsight'); }
  async applySidebar() {
    const side = vscode.workspace.getConfiguration('sourceInsightInspired').get('explorerSide', String('preserve'));
    if (!['left', 'right'].includes(side)) return;
    const workbench = vscode.workspace.getConfiguration('workbench');
    if (!this.context.workspaceState.get(SNAPSHOT)) {
      const target = this.target(), inspected = workbench.inspect?.('sideBar.location');
      const value = inspected ? target === vscode.ConfigurationTarget.Workspace ? inspected.workspaceValue : inspected.globalValue
        : workbench.get('sideBar.location');
      await this.context.workspaceState.update(SNAPSHOT, { target, hadValue: value !== undefined, value });
    }
    if (workbench.get('sideBar.location', String('left')) !== side) await workbench.update('sideBar.location', side, this.target());
    await this.context.workspaceState.update('layout.appliedSidebar', side);
  }
  async apply() {
    await this.applySidebar();
    await vscode.commands.executeCommand('workbench.action.positionPanelBottom');
    await vscode.commands.executeCommand('workbench.action.alignPanelJustify');
    const config = vscode.workspace.getConfiguration('sourceInsightInspired');
    if (this.mode() !== 'sourceInsight') await config.update('layout', 'sourceInsight', this.target());
    await this.context.workspaceState.update(APPLIED, true);
    await this.show();
  }
  async show() {
    const editor = vscode.window.activeTextEditor;
    if (this.mode() === 'sourceInsight') {
      await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
      // Context and Relation share one fixed two-column view; no native pane dragging required.
      await vscode.commands.executeCommand('sourceInsightInspired.context.focus', { preserveFocus: true });
    }
    await vscode.commands.executeCommand('sourceInsightInspired.symbols.focus', { preserveFocus: true });
    if (editor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }
  async initialize() {
    if (this.mode() === 'sourceInsight' && !this.context.workspaceState.get(APPLIED)) await this.apply();
    else await this.show();
  }
  async restore() {
    const config = vscode.workspace.getConfiguration('sourceInsightInspired');
    await config.update('layout', 'preserve', this.target());
    await config.update('explorerSide', 'preserve', this.target());
    const previous = this.context.workspaceState.get(SNAPSHOT);
    if (previous) {
      const workbench = vscode.workspace.getConfiguration('workbench');
      // Preserve a newer manual sidebar choice.
      if (workbench.get('sideBar.location', String('left')) === this.context.workspaceState.get('layout.appliedSidebar', 'right')) await workbench.update('sideBar.location', previous.hadValue ? previous.value : undefined, previous.target);
      await this.context.workspaceState.update(SNAPSHOT, undefined);
    }
    await this.context.workspaceState.update('layout.appliedSidebar', undefined);
    await this.context.workspaceState.update(APPLIED, undefined);
  }
}
module.exports = { ReadingLayout };
