'use strict';
const path = require('node:path');
const fs = require('node:fs');

function vscodeCandidates(platform, env, home) {
  if (platform === 'win32') {
    const join = path.win32.join;
    return [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      env.ProgramFiles && join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
      env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
      home && join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe')].filter(Boolean);
  }
  if (platform === 'darwin') return ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    path.join(home, 'Applications/Visual Studio Code.app/Contents/MacOS/Electron')];
  return ['/usr/share/code/code', '/usr/lib/code/code', '/opt/visual-studio-code/code', '/snap/code/current/usr/share/code/code'];
}

function findVSCode(platform, env, home, exists = fs.existsSync) {
  if (env.VSCODE_EXECUTABLE_PATH) {
    if (!exists(env.VSCODE_EXECUTABLE_PATH)) throw new Error(`VSCODE_EXECUTABLE_PATH does not exist: ${env.VSCODE_EXECUTABLE_PATH}`);
    return env.VSCODE_EXECUTABLE_PATH;
  }
  return vscodeCandidates(platform, env, home).find(exists);
}

function copyClangdExtension(installed, destination) {
  if (!fs.existsSync(installed)) return false;
  const folders = fs.readdirSync(installed).filter(name => name.startsWith('llvm-vs-code-extensions.vscode-clangd-'))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!folders.length) return false;
  fs.cpSync(path.join(installed, folders[0]), path.join(destination, folders[0]), { recursive: true, dereference: true });
  return true;
}

module.exports = { vscodeCandidates, findVSCode, copyClangdExtension };
