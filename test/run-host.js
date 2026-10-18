'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

async function main() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.argv.includes('--inside-xvfb')) {
    const result = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1440x1000x24 -nolisten tcp',
      process.execPath, __filename, '--inside-xvfb'], { stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  const { runTests } = require('@vscode/test-electron');
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'source-reader-host-'));
  const extensions = path.join(temporary, 'extensions');
  fs.mkdirSync(extensions);
  const installed = process.env.SOURCE_READER_EXTENSIONS_DIR || path.join(os.homedir(), '.vscode/extensions');
  for (const directory of fs.existsSync(installed) ? fs.readdirSync(installed) : []) {
    if (directory.startsWith('llvm-vs-code-extensions.vscode-clangd-')) {
      fs.symlinkSync(path.join(installed, directory), path.join(extensions, directory), 'dir');
    }
  }
  const executable = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === 'linux' ? '/usr/share/code/code' : undefined);
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'host'),
      extensionTestsEnv: { SOURCE_READER_HOST_TEST: '1', SOURCE_READER_REPORT: path.join(root, 'dist/host-results.json') },
      launchArgs: [path.join(root, 'examples/cpp'), '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
        `--user-data-dir=${path.join(temporary, 'user')}`, `--extensions-dir=${extensions}`]
    });
  } finally {
    // Preserve logs on failures so errors can be inspected without rerunning.
    console.log(`Extension host logs: ${temporary}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
