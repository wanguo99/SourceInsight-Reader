'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyRuntimeSources } = require('../scripts/verify-package');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-runtime-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { name: 'reader', version: '1.1.3', publisher: 'author', main: './src/extension.js',
    contributes: { commands: [{ command: 'reader.open', title: 'Open' }] } };
  const data = { 'package.json': JSON.stringify(source), 'package.nls.json': '{}', 'package.nls.zh-cn.json': '{}',
    'src/extension.js': "require('./worker');", 'src/worker.js': 'module.exports = 1;', 'media/bridge.js': 'current bridge' };
  const files = new Map();
  for (const [name, value] of Object.entries(data)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
    files.set('extension/' + name, Buffer.from(value));
  }
  return { root, files, source };
}

test('package verification compares every current runtime file, including workers and UI resources', t => {
  const { root, files } = fixture(t);
  assert.equal(verifyRuntimeSources(files, root), 5);
});

test('a same-version package with old worker bytes is rejected', t => {
  const { root, files } = fixture(t);
  files.set('extension/src/worker.js', Buffer.from('module.exports = 0;'));
  assert.throws(() => verifyRuntimeSources(files, root), /runtime differs.*worker/);
});

test('runtime comparison detects missing new files and leftover deleted modules', t => {
  const { root, files } = fixture(t);
  files.delete('extension/media/bridge.js');
  assert.throws(() => verifyRuntimeSources(files, root), /runtime differs.*bridge/);
  files.set('extension/media/bridge.js', Buffer.from('current bridge'));
  files.set('extension/src/retired.js', Buffer.from('old module'));
  assert.throws(() => verifyRuntimeSources(files, root), /Unexpected packaged runtime asset/);
});

test('same-version command and capability drift is rejected before a release can be shared', t => {
  const { root, files, source } = fixture(t);
  source.contributes.commands[0].title = 'Old command';
  files.set('extension/package.json', Buffer.from(JSON.stringify(source)));
  assert.throws(() => verifyRuntimeSources(files, root), /manifest differs.*contributes/);
});
