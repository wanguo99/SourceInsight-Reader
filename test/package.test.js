'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { archivePackages, packageExtension } = require('../scripts/package');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-package-')), directory = path.join(root, 'dist');
  fs.mkdirSync(directory); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'reader', version: '1.1.0' }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory };
}

test('packaging archives prior versions and sidecars without changing their bytes or older archives', t => {
  const { directory } = fixture(t), old = path.join(directory, 'archive', 'earlier');
  fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'reader-0.9.0.vsix'), 'historical');
  const files = { 'reader-1.0.0.vsix': 'first', 'reader-1.1.0-feature.vsix': 'second',
    'reader-1.1.0-feature.vsix.sha256': 'checksum', 'package-validation.json': '{}', 'sbom.cdx.json': '{}' };
  for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), data);
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'keep');
  const archive = archivePackages(directory), manifest = JSON.parse(fs.readFileSync(path.join(archive, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 5);
  for (const file of manifest.files) {
    assert.equal(fs.readFileSync(path.join(archive, file.name), 'utf8'), files[file.name]);
    assert.equal(file.sha256, crypto.createHash('sha256').update(files[file.name]).digest('hex'));
    assert(!fs.existsSync(path.join(directory, file.name)));
  }
  assert.deepEqual(manifest.moved.sort(), Object.keys(files).sort());
  assert.equal(fs.readFileSync(path.join(old, 'reader-0.9.0.vsix'), 'utf8'), 'historical');
  assert.equal(fs.readFileSync(path.join(directory, 'notes.txt'), 'utf8'), 'keep');
});

test('packaging archives before build and promotes only the verified version-only filename', async t => {
  const { root, directory } = fixture(t);
  fs.writeFileSync(path.join(directory, 'reader-1.1.0.vsix'), 'old');
  const output = await packageExtension(root, {
    build(file) {
      assert(!fs.existsSync(path.join(directory, 'reader-1.1.0.vsix')));
      const archive = fs.readdirSync(path.join(directory, 'archive'))[0];
      assert.equal(fs.readFileSync(path.join(directory, 'archive', archive, 'reader-1.1.0.vsix'), 'utf8'), 'old');
      assert.equal(path.basename(file), 'reader-1.1.0.vsix'); fs.writeFileSync(file, 'new');
    },
    verify(file) { assert.equal(fs.readFileSync(file, 'utf8'), 'new'); fs.writeFileSync(file + '.sha256', 'verified'); }
  });
  assert.equal(output, path.join(directory, 'reader-1.1.0.vsix'));
  assert.equal(fs.readFileSync(output, 'utf8'), 'new'); assert.equal(fs.readFileSync(output + '.sha256', 'utf8'), 'verified');
  assert(!fs.readdirSync(directory).some(name => name.startsWith('.package-build-')));
});

test('failed builds and verification preserve archived packages and never expose a partial release', async t => {
  for (const phase of ['build', 'verify']) {
    const { root, directory } = fixture(t); fs.writeFileSync(path.join(directory, 'reader-1.1.0.vsix'), 'old');
    await assert.rejects(packageExtension(root, {
      build(file) { fs.writeFileSync(file, 'partial'); if (phase === 'build') throw new Error('build failed'); },
      verify() { throw new Error('verify failed'); }
    }), new RegExp(phase + ' failed'));
    assert(!fs.existsSync(path.join(directory, 'reader-1.1.0.vsix')));
    assert(!fs.readdirSync(directory).some(name => name.startsWith('.package-build-')));
    const archive = fs.readdirSync(path.join(directory, 'archive'))[0];
    assert.equal(fs.readFileSync(path.join(directory, 'archive', archive, 'reader-1.1.0.vsix'), 'utf8'), 'old');
  }
});
