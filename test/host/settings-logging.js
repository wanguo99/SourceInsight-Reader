'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { captureUi } = require('./capture');
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (predicate()) return; await pause(); }
  throw new Error('Settings/logging update timed out');
}
async function run() {
  const controller = await vscode.extensions.getExtension('wanguo.wanguo-sourceinsight-reader').activate();
  const results = [];
  async function check(name, action) { await action(); results.push({ name, passed: true }); console.log('PASS ' + name); }
  try {
    await check('default settings show actual cache and log paths while leaving configuration empty', async () => {
      const paths = controller.appearancePanel.paths();
      const cache = paths['feature.cacheDirectory'];
      assert.deepEqual(Object.keys(paths), ['feature.cacheDirectory']);
      assert(path.isAbsolute(cache.placeholder)); assert(cache.pathHint.includes(cache.placeholder));
      assert(cache.pathHint.includes('indexes')); assert(cache.pathHint.includes('logs'));
      assert.equal(vscode.workspace.getConfiguration('sourceInsightReader').get('cacheDirectory'), '');
      await vscode.commands.executeCommand('sourceInsightReader.openSettings');
      await waitFor(() => controller.appearancePanel.channel?.received > 0);
      await new Promise(resolve => setTimeout(resolve, 1000)); await captureUi('settings-log-paths');
    });
    await check('file logging persists output and switches directories through the settings page', async () => {
      const original = controller.output.writer.file;
      controller.output.appendLine('host-log-before-switch'); await controller.output.flush();
      assert((await fs.readFile(original, 'utf8')).includes('host-log-before-switch'));
      const directory = path.join(path.dirname(vscode.workspace.workspaceFolders[0].uri.fsPath), '日志 output');
      const result = await controller.appearancePanel.handle({ action: 'settingsSave', mode: 'workspace', query: JSON.stringify({ 'feature.cacheDirectory': directory }) });
      assert(!result?.error); await waitFor(() => controller.output.directory === directory);
      controller.output.appendLine('host-log-after-switch'); await controller.output.flush();
      const current = controller.output.writer.file;
      assert.equal(path.basename(path.dirname(current)), 'logs');
      const { databasePath } = require('../../src/infrastructure/index-database');
      const project = vscode.workspace.workspaceFolders[0].uri.toString();
      assert.equal(path.dirname(path.dirname(databasePath(directory, project))), path.dirname(path.dirname(current)));
      await controller.localIndex.refresh();
      assert((await fs.stat(databasePath(directory, project))).isFile());
      assert((await fs.readFile(current, 'utf8')).includes('host-log-after-switch'));
      assert(!(await fs.readFile(original, 'utf8')).includes('host-log-after-switch'));
      assert(controller.appearancePanel.paths()['feature.cacheDirectory'].pathHint.includes(directory));
      await controller.appearancePanel.handle({ action: 'settingsSave', mode: 'workspace', query: JSON.stringify({ 'feature.fileLoggingEnabled': 'false' }) });
      await waitFor(() => !controller.output.writer);
      controller.output.appendLine('host-output-only'); await controller.output.flush();
      assert(!(await fs.readFile(current, 'utf8')).includes('host-output-only'));
      await controller.appearancePanel.handle({ action: 'settingsSave', mode: 'workspace', query: JSON.stringify({ 'feature.fileLoggingEnabled': 'true', 'feature.cacheDirectory': '' }) });
      await waitFor(() => controller.output.writer?.file === original);
      controller.output.appendLine('host-log-restored'); await controller.output.flush();
      assert((await fs.readFile(original, 'utf8')).includes('host-log-restored'));
    });
  } finally {
    controller.appearancePanel.panel?.dispose(); await controller.output.flush();
    await fs.writeFile(process.env.SOURCEINSIGHT_READER_REPORT, JSON.stringify({ passed: results.length, results }, null, 2));
  }
}
module.exports = { run };
