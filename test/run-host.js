'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { findVSCode, copyClangdExtension } = require('../scripts/platform');

async function main() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.argv.includes('--inside-xvfb')) {
    const result = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24 -nolisten tcp',
      process.execPath, __filename, '--inside-xvfb'], { stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1; return;
  }
  const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sourceinsight-reader-host-'));
  const extensions = path.join(temporary, 'extensions');
  const workspace = path.join(temporary, 'C++ 示例 workspace');
  const user = path.join(temporary, 'user');
  fs.mkdirSync(extensions);
  fs.cpSync(path.join(root, 'examples/cpp'), workspace, { recursive: true,
    filter: source => !['build', '.cache', 'compile_commands.json'].includes(path.basename(source)) });
  if (process.env.CLANGD_PATH) {
    const settingsFile = path.join(workspace, '.vscode/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings['clangd.path'] = process.env.CLANGD_PATH;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  }
  const installed = process.env.SOURCEINSIGHT_READER_EXTENSIONS_DIR || path.join(os.homedir(), '.vscode/extensions');
  let executable = findVSCode(process.platform, process.env, os.homedir());
  if (!executable && process.env.SOURCEINSIGHT_READER_DOWNLOAD_VSCODE === '1') executable = await downloadAndUnzipVSCode('stable');
  if (!executable) throw new Error('未找到 VS Code。请设置 VSCODE_EXECUTABLE_PATH 指向 Code.exe / Electron 可执行文件，或设置 SOURCEINSIGHT_READER_DOWNLOAD_VSCODE=1。');
  const copied = copyClangdExtension(installed, extensions);
  if (!copied) {
    if (process.env.SOURCEINSIGHT_READER_INSTALL_CLANGD_EXTENSION !== '1') throw new Error('未找到 clangd 扩展。请先安装扩展，或设置 SOURCEINSIGHT_READER_INSTALL_CLANGD_EXTENSION=1。');
    // Invoke the JavaScript CLI through Electron-as-Node, avoiding cmd.exe quoting entirely.
    const cliScript = process.platform === 'darwin'
      ? path.resolve(path.dirname(executable), '../Resources/app/out/cli.js')
      : path.join(path.dirname(executable), 'resources/app/out/cli.js');
    if (!fs.existsSync(cliScript)) throw new Error('无法定位 VS Code JavaScript CLI，请先手动安装 clangd 扩展。');
    const install = spawnSync(executable, [cliScript, '--install-extension', 'llvm-vs-code-extensions.vscode-clangd',
      '--force', `--extensions-dir=${extensions}`, `--user-data-dir=${user}`], { stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    if (install.error) throw install.error;
    if (install.status !== 0) throw new Error(`安装 clangd 扩展失败：${install.status}`);
  }
  try {
    await runTests({
      vscodeExecutablePath: executable, extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'host'),
      extensionTestsEnv: { SOURCEINSIGHT_READER_HOST_TEST: '1', SOURCEINSIGHT_READER_REPORT: path.join(root, 'dist/host-results.json') },
      launchArgs: [workspace, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
        `--user-data-dir=${user}`, `--extensions-dir=${extensions}`]
    });
  } finally { console.log(`Extension host logs: ${temporary}`); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
