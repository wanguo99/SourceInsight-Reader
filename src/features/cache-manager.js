'use strict';
const path = require('node:path');
const vscode = require('vscode');
const { t } = require('../i18n');
const { indexStorageDirectory } = require('../infrastructure/index-storage-path');
const { listCacheFiles, deleteCacheFile, formatBytes } = require('../infrastructure/cache-files');

async function manageCache(context) {
  const configured = vscode.workspace.getConfiguration('sourceInsightReader').get('indexCacheDirectory', '');
  const directories = [indexStorageDirectory(context, configured), indexStorageDirectory(context)];
  const entries = await listCacheFiles(directories, context.storageUri ? [path.join(context.storageUri.fsPath, 'c-index-v2.json')] : []);
  if (!entries.length) { await vscode.window.showInformationMessage(t('没有本地缓存文件')); return; }
  const choices = entries.map(entry => {
    let name = entry.project;
    try { if (name.startsWith('file:')) name = path.basename(vscode.Uri.parse(name).fsPath) || name; } catch (error) { /* Show a readable fallback for old cache labels. */ }
    if (/^[a-f0-9]{64}$/.test(name)) name = name.slice(0, 12);
    return { label: `${entry.inUse ? '$(lock)' : '$(database)'} ${formatBytes(entry.size)} · ${name}`,
      description: entry.inUse ? t('正在使用') : t('可删除'),
      detail: `${entry.files.map(file => `${path.basename(file.path)}: ${formatBytes(file.size)}`).join(' · ')} · ${entry.path}`, entry };
  });
  const selected = await vscode.window.showQuickPick(choices, { title: t('管理本地缓存'), canPickMany: true, matchOnDescription: true, matchOnDetail: true,
    placeHolder: t('选择一个或多个缓存删除；每项显示文件大小，正在使用的缓存不可删除') });
  if (!selected?.length) return;
  const busy = selected.filter(choice => choice.entry.inUse), available = selected.filter(choice => !choice.entry.inUse);
  if (busy.length) await vscode.window.showWarningMessage(t('以下缓存正在使用，禁止删除：') + '\n' + busy.map(choice => choice.entry.path).join('\n'), { modal: true });
  if (!available.length) return;
  const confirm = t('删除缓存');
  const response = await vscode.window.showWarningMessage(t('删除选中的缓存文件？下次使用时会重新创建索引。'),
    { modal: true, detail: available.map(choice => `${choice.entry.path} (${formatBytes(choice.entry.size)})`).join('\n') }, confirm);
  if (response !== confirm) return;
  let deleted = 0; const failures = [];
  for (const choice of available) {
    try {
      const result = await deleteCacheFile(choice.entry);
      if (result.inUse) failures.push(t('缓存正在使用，禁止删除：') + choice.entry.path);
      else if (result.deleted) deleted++;
    } catch (error) { failures.push(`${choice.entry.path}: ${error.message}`); }
  }
  if (failures.length) await vscode.window.showWarningMessage(t('部分缓存未删除：') + '\n' + failures.join('\n'), { modal: true });
  if (deleted) await vscode.window.showInformationMessage(`${t('已删除缓存文件：')}${deleted}`);
}
module.exports = { manageCache };
