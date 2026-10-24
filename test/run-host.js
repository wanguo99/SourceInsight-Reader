'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { findVSCode, copyClangdExtension } = require('../scripts/platform');

async function main() {
  if (!process.argv.includes('--bounded-host')) {
    const timeoutMs = Number(process.env.SOURCEINSIGHT_READER_HOST_TIMEOUT_MS || 600000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('Invalid host timeout');
    await require('../scripts/run-bounded').runBounded(process.execPath, [__filename, '--bounded-host', ...process.argv.slice(2)], { timeoutMs }); return;
  }
  if (process.platform === 'linux' && (!process.env.DISPLAY || process.argv.includes('--headless')) && !process.argv.includes('--inside-xvfb')) {
    const result = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24 -nolisten tcp',
      process.execPath, __filename, '--inside-xvfb', ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1; return;
  }
  const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
  const root = path.resolve(__dirname, '..');
  const profile = process.env.SOURCEINSIGHT_READER_LANGUAGE;
  const offlineColors = process.argv.includes('--offline-colors');
  if (profile && !['java', 'python'].includes(profile)) throw new Error('Invalid language profile');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sourceinsight-reader-host-'));
  const extensions = path.join(temporary, 'extensions');
  const workspace = path.join(temporary, 'C++ 示例 workspace');
  const user = path.join(temporary, 'user');
  fs.mkdirSync(extensions);
  fs.cpSync(path.join(root, 'examples', profile || 'cpp'), workspace, { recursive: true,
    filter: source => !['build', '.cache', 'compile_commands.json'].includes(path.basename(source)) });
  if (process.env.CLANGD_PATH && !profile) {
    const settingsFile = path.join(workspace, '.vscode/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings['clangd.path'] = process.env.CLANGD_PATH;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  }
  const installed = process.env.SOURCEINSIGHT_READER_EXTENSIONS_DIR || path.join(os.homedir(), '.vscode/extensions');
  let executable = findVSCode(process.platform, process.env, os.homedir());
  const requested = process.env.SOURCEINSIGHT_READER_VSCODE_VERSION;
  if (requested || !executable && process.env.SOURCEINSIGHT_READER_DOWNLOAD_VSCODE === '1') executable = await downloadAndUnzipVSCode(requested || 'stable');
  if (!executable) throw new Error('未找到 VS Code。请设置 VSCODE_EXECUTABLE_PATH 指向 Code.exe / Electron 可执行文件，或设置 SOURCEINSIGHT_READER_DOWNLOAD_VSCODE=1。');
  const cliScript = process.platform === 'darwin'
    ? path.resolve(path.dirname(executable), '../Resources/app/out/cli.js')
    : path.join(path.dirname(executable), 'resources/app/out/cli.js');
  const installExtension = id => {
    if (!fs.existsSync(cliScript)) throw new Error('VS Code CLI not found');
    const result = spawnSync(executable, [cliScript, '--install-extension', id, '--force', `--extensions-dir=${extensions}`, `--user-data-dir=${user}`],
      { stdio: 'inherit', timeout: 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    if (result.error || result.status !== 0) throw result.error || new Error('Extension installation failed: ' + id);
  };
  if (profile) {
    for (const id of profile === 'java' ? ['redhat.java'] : ['ms-python.python', 'ms-python.vscode-pylance']) installExtension(id);
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
      'sourceInsightReader.autoPreview': false, 'sourceInsightReader.autoRelation': false,
      'java.server.launchMode': 'Standard', 'python.defaultInterpreterPath': process.env.SOURCEINSIGHT_READER_PYTHON || 'python3',
      'python.analysis.languageServerMode': 'default', 'python.languageServer': 'Pylance'
    }, null, 2));
  } else if (!offlineColors && !copyClangdExtension(installed, extensions)) {
    if (process.env.SOURCEINSIGHT_READER_INSTALL_CLANGD_EXTENSION !== '1') throw new Error('clangd extension unavailable; set SOURCEINSIGHT_READER_INSTALL_CLANGD_EXTENSION=1');
    installExtension('llvm-vs-code-extensions.vscode-clangd');
  }
  let extensionPath = root;
  const vsix = process.argv.find(value => value.startsWith('--vsix='))?.slice(7);
  if (vsix) {
    const cliScript = process.platform === 'darwin' ? path.resolve(path.dirname(executable), '../Resources/app/out/cli.js') : path.join(path.dirname(executable), 'resources/app/out/cli.js');
    const installed = spawnSync(executable, [cliScript, '--install-extension', path.resolve(vsix), '--force', `--extensions-dir=${extensions}`, `--user-data-dir=${user}`],
      { stdio: 'inherit', timeout: 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    if (installed.error || installed.status !== 0) throw installed.error || new Error('VSIX installation failed');
    const { publisher, name, version } = require('../package.json');
    extensionPath = path.join(extensions, `${publisher}.${name}-${version}`);
    if (!fs.existsSync(path.join(extensionPath, 'package.json'))) throw new Error('Installed VSIX not found');
  }
  try {
    await runTests({
      vscodeExecutablePath: executable, extensionDevelopmentPath: extensionPath,
      extensionTestsPath: path.join(__dirname, 'host', ...(offlineColors ? ['colors.js'] : profile ? ['languages.js'] : [])),
      extensionTestsEnv: { SOURCEINSIGHT_READER_HOST_TEST: '1', SOURCEINSIGHT_READER_REPORT: path.join(root, 'dist', offlineColors ? 'host-offline-colors-results.json' : profile ? 'host-' + profile + '-results.json' : 'host-results.json'),
        SOURCEINSIGHT_READER_COLOR_FIXTURE: process.env.SOURCEINSIGHT_READER_COLOR_FIXTURE || '',
        SOURCEINSIGHT_READER_CAPTURE_UI: process.argv.includes('--capture-ui') ? '1' : '', SOURCEINSIGHT_READER_INSTALLATION: vsix ? 'vsix' : 'development' },
      launchArgs: [workspace, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
        `--user-data-dir=${user}`, `--extensions-dir=${extensions}`,
        ...(process.argv.includes('--capture-ui') ? ['--remote-debugging-port=9327', '--remote-debugging-address=127.0.0.1'] : [])]
    });
  } finally { console.log(`Extension host logs: ${temporary}`); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
