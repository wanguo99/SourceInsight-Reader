'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { uriKey, sameUri, relativeUriPath } = require('../src/resources');
const { locationKey, uniqueLocations } = require('../src/core');
const { vscodeCandidates, findVSCode, copyClangdExtension } = require('../scripts/platform');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('Windows drive URIs compare consistently across case, escaped spaces and Chinese paths', () => {
  const a = 'file:///C:/Code%20Reader/%E4%B8%AD%E6%96%87/Main.CPP';
  const b = 'file:///c:/code%20reader/中文/main.cpp';
  assert.equal(uriKey(a), uriKey(b));
  assert.equal(sameUri(a, b), true);
  const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
  assert.equal(locationKey({ uri: a, range }), locationKey({ uri: b, range }));
  assert.equal(uniqueLocations([{ uri: a, range }, { uri: b, range }]).length, 1);
});

test('UNC roots use server/share boundaries; POSIX and remote resource paths preserve case', () => {
  assert.equal(relativeUriPath('file://SERVER/Share/Project/', 'file://server/share/project/src/文件.cpp'), 'src/文件.cpp');
  assert.equal(relativeUriPath('file://SERVER/Share/Project', 'file://server/Share/Project2/a.cpp'), undefined);
  assert.equal(relativeUriPath('file:///C:/', 'file:///c:/Project/a.cpp'), 'Project/a.cpp');
  assert.equal(relativeUriPath('file:///C:/Project', 'file:///D:/Project/a.cpp'), undefined);
  assert.equal(sameUri('file:///src/A.cpp', 'file:///src/a.cpp'), false);
  assert.equal(sameUri('vscode-remote://ssh-remote+host/src/A.cpp', 'vscode-remote://ssh-remote+host/src/a.cpp'), false);
});

test('Windows VS Code discovery covers user and system installs, including paths with spaces', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\User Name\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };
  const candidates = vscodeCandidates('win32', env, 'C:\\Users\\User Name');
  assert.ok(candidates.includes('C:\\Program Files\\Microsoft VS Code\\Code.exe'));
  const executable = candidates[0];
  assert.equal(findVSCode('win32', env, '', value => value === executable), executable);
  assert.equal(findVSCode('win32', { VSCODE_EXECUTABLE_PATH: 'D:\\工具\\VS Code\\Code.exe' }, '', () => true), 'D:\\工具\\VS Code\\Code.exe');
  assert.throws(() => findVSCode('win32', { VSCODE_EXECUTABLE_PATH: 'missing' }, '', () => false), /does not exist/);
});

test('extension test preparation copies the latest clangd folder without symlink privileges', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sourceinsight-reader-copy-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const installed = path.join(temporary, 'installed'), destination = path.join(temporary, '目标 extensions');
  fs.mkdirSync(destination); fs.mkdirSync(installed);
  for (const version of ['0.9.0', '0.10.0']) {
    const folder = path.join(installed, `llvm-vs-code-extensions.vscode-clangd-${version}`);
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ version }));
  }
  assert.equal(copyClangdExtension(installed, destination), true);
  const [folder] = fs.readdirSync(destination);
  assert.ok(folder.endsWith('0.10.0'));
  assert.equal(fs.lstatSync(path.join(destination, folder)).isSymbolicLink(), false);
});
