'use strict';
const { t } = require('../i18n');
const vscode = require('vscode');
const { relativeUriPath } = require('../resources');
async function excludeReadingEntries(catalog, entries) {
  const folders = [...(vscode.workspace.workspaceFolders || [])].sort((a, b) => b.uri.path.length - a.uri.path.length);
  const config = vscode.workspace.getConfiguration('sourceInsightReader');
  const directories = config.get('excludedDirectories', []), files = config.get('excludedFiles', []);
  const nextDirectories = [...directories], nextFiles = [...files];
  for (const entry of entries) {
    const folder = folders.find(root => relativeUriPath(root.uri, entry.uri) !== undefined);
    if (!folder || !catalog.contains(entry.uri)) continue;
    const value = folders.length === 1 ? relativeUriPath(folder.uri, entry.uri) || '.' : entry.uri.toString();
    const target = entry.type === 'directory' ? nextDirectories : nextFiles;
    if (!target.includes(value)) target.push(value);
  }
  // Drop redundant descendants when a selected parent directory is blocked too.
  const resolved = catalog.scope.resolve(nextDirectories);
  const compactFiles = nextFiles.filter(value => !catalog.scope.resolve([value]).some(file =>
    resolved.some(directory => relativeUriPath(directory.uri, file.uri) !== undefined)));
  if (JSON.stringify(nextDirectories) !== JSON.stringify(directories)) await config.update('excludedDirectories', nextDirectories, vscode.ConfigurationTarget.Workspace);
  if (JSON.stringify(compactFiles) !== JSON.stringify(files)) await config.update('excludedFiles', compactFiles, vscode.ConfigurationTarget.Workspace);
}
async function manageReadingDirectories(catalog) {
  const config = vscode.workspace.getConfiguration('sourceInsightReader');
  const choices = ['excludedDirectories', 'excludedFiles'].flatMap(key => config.get(key, []).map(value => ({
    label: t('$(remove) 取消屏蔽') + (key === 'excludedFiles' ? t('文件：') : t('目录：')) + value,
    action: 'remove', key, value
  })));
  if (!choices.length) { await vscode.window.showInformationMessage(t('暂无屏蔽项。请在工程文件树中右键文件或目录进行屏蔽，支持 Shift 连选和 Ctrl / Cmd 多选。')); return; }
  choices.push({ label: t('$(clear-all) 取消全部屏蔽'), action: 'reset', key: '', value: '' });
  const choice = await vscode.window.showQuickPick(choices, { placeHolder: t('管理已屏蔽的文件和目录'), matchOnDescription: true });
  if (!choice) return;
  if (choice.action === 'reset') {
    await config.update('excludedDirectories', [], vscode.ConfigurationTarget.Workspace);
    await config.update('excludedFiles', [], vscode.ConfigurationTarget.Workspace);
  } else await config.update(choice.key, config.get(choice.key, []).filter(value => value !== choice.value), vscode.ConfigurationTarget.Workspace);
}
module.exports = { manageReadingDirectories, excludeReadingEntries };
