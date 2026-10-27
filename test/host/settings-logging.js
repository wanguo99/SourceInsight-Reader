'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { captureUi, webviewContext } = require('./capture');
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
    await check('opening a folder does not start a local index or persistent semantic database', async () => {
      assert.equal(await controller.localIndex.ensure(), false);
      assert.equal(controller.localIndex.worker, undefined);
      assert.equal(controller.indexStore.worker, undefined);
      assert.match(controller.localIndex.getStatus().message, /开始索引/);
    });
    await check('reload window is registered and displayed immediately beside settings', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert(commands.includes('sourceInsightReader.reloadWindow'));
      await vscode.commands.executeCommand('sourceInsightReader.focusFileSearch');
      await new Promise(resolve => setTimeout(resolve, 700));
      await captureUi('reload-window-toolbar', async send => {
        // Drag the actual workbench sash; focus can still be inside an editor
        // while the webview is activating, so resize commands are ambiguous.
        const boundary = await send('Runtime.evaluate', { expression: `(() => {
          const box = document.querySelector('.part.auxiliarybar').getBoundingClientRect();
          const sash = Array.from(document.querySelectorAll('.monaco-sash.vertical')).map(node => node.getBoundingClientRect()).filter(r => r.height > 100 && r.width > 0).sort((a,b) => Math.abs(a.x + a.width / 2 - box.x) - Math.abs(b.x + b.width / 2 - box.x))[0];
          return { x: sash.x + sash.width / 2, y: sash.y + sash.height / 2 };
        })()`, returnByValue: true });
        const { x, y } = boundary.result.value;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, x, y });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: x - 220, y });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: x - 220, y });
        await new Promise(resolve => setTimeout(resolve, 300));
        const result = await send('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll('.part.auxiliarybar .action-label')).map(node => {
          const r = node.getBoundingClientRect();
          return { label: node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent, x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width };
        }).filter(node => node.width > 0)`, returnByValue: true });
        const labels = result.result.value;
        const reload = labels.findIndex(item => /Reload Window|重载窗口/.test(item.label));
        assert(reload >= 0, JSON.stringify(labels));
        assert.match(labels[reload - 1].label, /Settings|设置/);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: labels[reload].x, y: labels[reload].y });
        await new Promise(resolve => setTimeout(resolve, 700));
      });
    });
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
    await check('resource sliders are published and resource previews do not change settings', async () => {
      const { featureOptions, describeFeature } = require('../../src/feature-options');
      for (const key of ['indexCpuLimitPercent', 'indexMemoryAvailablePercent']) {
        const option = featureOptions.find(value => value.key === key);
        assert(describeFeature(option, option.schema.default).slider);
      }
      await controller.appearancePanel.handle({ action: 'settingsResourcePreview', query: JSON.stringify({
        'feature.indexCpuLimitPercent': '80', 'feature.indexMemoryMode': 'availablePercent', 'feature.indexMemoryAvailablePercent': '50' }) });
      assert.equal(vscode.workspace.getConfiguration('sourceInsightReader').get('indexCpuLimitPercent'), 25);
      await captureUi('settings-resource-budget');
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
      await controller.localIndex.startSession();
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
    await check('project imports restrict real enumeration and indexing and expose a management popup', async () => {
      const config = vscode.workspace.getConfiguration('sourceInsightReader');
      const files = await controller.catalog.list({ pattern: '**/*.{c,cpp,h}' }); assert(files.length > 1);
      const selected = files.find(uri => /\.(c|cpp)$/.test(uri.path)); assert(selected);
      await config.update('projectSources', { mode: 'selected', directories: [], files: [selected.toString()] }, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => controller.catalog.scope.snapshot().selected);
      assert.deepEqual((await controller.catalog.list()).map(uri => uri.toString()), [selected.toString()]);
      await controller.localIndex.startSession();
      assert.equal(controller.localIndex.summary.files, 1);
      const identity = controller.catalog.projectKey(selected); assert(identity.includes('readerScope='));
      await config.update('projectSources', { mode: 'selected', directories: [], files: [] }, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => controller.catalog.scope.snapshot().includedFiles.length === 0);
      await controller.localIndex.startSession(); assert.equal(controller.localIndex.summary.files, 0);
      assert.deepEqual(await controller.catalog.list(), []);
      await vscode.commands.executeCommand('sourceInsightReader.manageProjectSources');
      const manager = controller.projectSources; await manager.queue;
      await manager.handle({ action: 'expand', id: manager.roots[0].id });
      const entry = [...manager.nodes.values()].find(node => node.uri.toString() === selected.toString()); assert(entry);
      await manager.handle({ action: 'toggle', id: entry.id, type: true });
      assert.equal(controller.catalog.scope.selection().files.length, 0, 'Checkbox changes remain a draft');
      assert.equal(manager.selected.size, 1);
      await new Promise(resolve => setTimeout(resolve, 700)); await captureUi('project-source-manager');
      await manager.handle({ action: 'save' });
      await controller.localIndex.startSession(); assert.equal(controller.localIndex.summary.files, 1);
      await manager.handle({ action: 'remove', id: entry.id }); assert.equal(manager.selected.size, 0);
      await manager.handle({ action: 'save' });
      await controller.localIndex.startSession(); assert.equal(controller.localIndex.summary.files, 0);
      manager.panel.dispose();
      await vscode.commands.executeCommand('sourceInsightReader.focusFileSearch');
      await new Promise(resolve => setTimeout(resolve, 700)); await captureUi('file-management-context-menu', async send => {
        const position = await send('Runtime.evaluate', { expression: `(() => {
          const box = document.querySelector('.part.auxiliarybar').getBoundingClientRect();
          return { x: box.x + box.width / 2, y: Math.min(box.bottom - 30, box.top + 160) };
        })()`, returnByValue: true });
        const { x, y } = position.result.value;
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', buttons: 2, clickCount: 1, x, y });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', buttons: 0, clickCount: 1, x, y });
        let text = '';
        for (let i = 0; i < 30; i++) {
          const menu = await send('Runtime.evaluate', { expression: `document.querySelector('.context-view .monaco-menu')?.innerText || ''`, returnByValue: true });
          text = menu.result.value;
          if (/Manage Project Files|管理工程文件/.test(text) && /Manage Exclusions|管理屏蔽项/.test(text)) break;
          await pause();
        }
        assert.match(text, /Manage Project Files|管理工程文件/);
        assert.match(text, /Manage Exclusions|管理屏蔽项/);
        return async () => {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        };
      });
    });
    await check('project import panes are side by side and native Shift checkboxes update one draft range', async () => {
      const root = vscode.workspace.workspaceFolders[0].uri, folder = vscode.Uri.joinPath(root, 'range-import');
      await fs.mkdir(folder.fsPath, { recursive: true });
      for (const name of ['a.c', 'b.c', 'c.c', 'd.c']) await fs.writeFile(vscode.Uri.joinPath(folder, name).fsPath, 'int range_item;');
      await vscode.commands.executeCommand('sourceInsightReader.manageProjectSources');
      const manager = controller.projectSources; await manager.queue;
      await manager.handle({ action: 'expand', id: manager.roots[0].id });
      const group = [...manager.nodes.values()].find(node => node.uri.toString() === folder.toString()); assert(group);
      await manager.handle({ action: 'expand', id: group.id });
      const nodes = ['a.c', 'b.c', 'c.c', 'd.c'].map(name => [...manager.nodes.values()].find(node => node.uri.toString() === vscode.Uri.joinPath(folder, name).toString()));
      await manager.handle({ action: 'toggle', id: nodes[0].id, type: true });
      await manager.handle({ action: 'range', mode: 'tree', id: nodes[3].id, type: true });
      assert.equal(manager.selected.size, 4);
      await new Promise(resolve => setTimeout(resolve, 500));
      await captureUi('project-import-side-by-side', async send => {
        const evaluate = await webviewContext(send, 'source-picker');
        const boxes = await evaluate(`Array.from(document.querySelectorAll('#source-picker > section')).map(node => { const r = node.getBoundingClientRect(); return { x: r.x, width: r.width, y: r.y }; })`);
        assert(boxes[1].x >= boxes[0].x + boxes[0].width, 'Import sections must be side by side');
        assert.equal(boxes[0].y, boxes[1].y);
        await manager.handle({ action: 'clear' });
        await new Promise(resolve => setTimeout(resolve, 150));
        const click = (id, shiftKey = false) => evaluate(`document.getElementById(${JSON.stringify(id)}).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: ${shiftKey} }))`);
        await click('check-' + nodes[0].id); await waitFor(() => manager.selected.size === 1);
        await click('check-' + nodes[3].id, true); await waitFor(() => manager.selected.size === 4);
        return async () => {
          await click('remove-' + nodes[0].id); await waitFor(() => manager.selected.size === 3);
          await click('remove-' + nodes[2].id, true); await waitFor(() => manager.selected.size === 1);
          assert.equal([...manager.selected.values()][0].id, nodes[3].id);
        };
      });
      assert.deepEqual(controller.catalog.scope.selection().files, [], 'Checkbox interaction only changes the draft');
      manager.panel.dispose();
    });
    await check('compilation database mode starts explicitly and excludes uncompiled sources', async () => {
      const root = vscode.workspace.workspaceFolders[0].uri;
      const database = vscode.Uri.joinPath(root, 'compile_commands.json');
      await fs.writeFile(vscode.Uri.joinPath(root, 'not-in-compilation.c').fsPath, 'int should_not_be_indexed;');
      await fs.writeFile(database.fsPath, JSON.stringify([{ directory: root.fsPath, file: 'main.cpp', arguments: ['c++', '-I', root.fsPath, '-c', 'main.cpp'] }]));
      await vscode.workspace.getConfiguration('sourceInsightReader').update('projectSources', { mode: 'compilation', directories: [], files: [], compilationDatabase: database.toString() }, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => !controller.localIndex.enabled());
      assert.equal(await controller.localIndex.ensure(), false);
      await controller.localIndex.startSession();
      const compiled = controller.catalog.scope.compilation;
      assert.equal(compiled.sources, 1); assert(compiled.files.some(file => file.endsWith('/main.cpp')));
      assert(!compiled.files.some(file => file.endsWith('/not-in-compilation.c')));
      assert.equal(controller.localIndex.summary.files, compiled.files.length);
      // Exercise mappings through the real catalog Worker and index Worker.
      const build = vscode.Uri.joinPath(root, 'build-copy');
      await fs.mkdir(build.fsPath, { recursive: true });
      await fs.writeFile(database.fsPath, JSON.stringify([{ directory: build.fsPath, file: 'main.cpp', arguments: ['c++', '-I', build.fsPath] }]));
      await vscode.workspace.getConfiguration('sourceInsightReader').update('projectSources', { mode: 'compilation', directories: [], files: [], compilationDatabase: database.toString(), pathMappings: [{ from: build.fsPath, to: root.fsPath }] }, vscode.ConfigurationTarget.Workspace);
      await waitFor(() => !controller.localIndex.enabled());
      await controller.localIndex.startSession();
      assert.equal(controller.catalog.scope.compilation.mappedSources, 1);
      assert.equal(controller.localIndex.summary.files, compiled.files.length);
      const manager = controller.projectSources;
      manager.show(); await manager.queue;
      await manager.handle({ action: 'ready' });
      await new Promise(resolve => setTimeout(resolve, 700)); await captureUi('compilation-path-mappings');
      manager.panel.dispose();
    });
  } finally {
    controller.appearancePanel.panel?.dispose(); await controller.output.flush();
    await fs.writeFile(process.env.SOURCEINSIGHT_READER_REPORT, JSON.stringify({ passed: results.length, results }, null, 2));
  }
}
module.exports = { run };
