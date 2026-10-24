'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function readZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    const files = new Map();
    const fail = error => { zip.close(); reject(error); };
    zip.on('error', fail);
    zip.on('entry', entry => {
      const name = entry.fileName;
      if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || files.has(name)) return fail(new Error('Unsafe or duplicate ZIP entry: ' + name));
      if (name.endsWith('/')) { zip.readEntry(); return; }
      if (entry.uncompressedSize > 16 * 1024 * 1024) return fail(new Error('Unexpected large package entry: ' + name));
      zip.openReadStream(entry, (error, stream) => {
        if (error) return fail(error);
        const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', fail);
        stream.on('end', () => { files.set(name, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.on('end', () => resolve(files)); zip.readEntry();
  }));
}
async function verify(file, root = path.resolve(__dirname, '..'), generate = false) {
  const digest = hash(fs.readFileSync(file));
  if (!generate && (!fs.existsSync(file + '.sha256') || fs.readFileSync(file + '.sha256', 'utf8').split(/\s/)[0] !== digest)) throw new Error('Missing or mismatched package SHA-256');
  const files = await readZip(file), source = require(path.join(root, 'package.json'));
  const manifest = JSON.parse(files.get('extension/package.json')?.toString() || '{}');
  if (manifest.name !== source.name || manifest.version !== source.version) throw new Error('Package identity differs from workspace');
  const required = ['package.json', 'package.nls.json', 'package.nls.zh-cn.json', manifest.main.replace(/^\.\//, ''),
    'src/index-worker.js', 'src/c-color-worker.js', 'src/textmate-worker.js', 'src/text-search-worker.js', 'shared/protocol.js',
    ...manifest.contributes.themes.map(theme => theme.path.replace(/^\.\//, '')), 'media/messages.en.json'];
  if (![...files.keys()].some(name => /^extension\/licen[sc]e(?:\.(?:md|txt))?$/i.test(name))) throw new Error('Missing extension license');
  for (const file of required) if (!files.has('extension/' + file)) throw new Error('Missing runtime asset: ' + file);
  for (const [name, buffer] of files) {
    if (/^extension\/(?:node_modules|test|scripts|\.git|dist)\//.test(name)) throw new Error('Development files leaked: ' + name);
    if (name.endsWith('.js') && name.startsWith('extension/src/')) {
      for (const match of buffer.toString().matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
        if (![base, base + '.js', base + '.json', base + '/index.js'].some(value => files.has(value))) throw new Error(`Missing module ${match[1]} from ${name}`);
      }
    }
  }
  const components = [];
  for (const directory of ['vendor/tree-sitter', 'vendor/textmate']) {
    const manifest = JSON.parse(files.get('extension/' + directory + '/manifest.json').toString());
    for (const asset of manifest) {
      const name = directory + '/' + asset.name, data = files.get('extension/' + name);
      if (!data || hash(data) !== asset.sha256) throw new Error('Vendored asset mismatch: ' + name);
      components.push({ type: 'file', name, version: asset.version || asset.sha, 'bom-ref': name,
        hashes: [{ alg: 'SHA-256', content: hash(data) }], externalReferences: [{ type: 'distribution', url: asset.source }] });
    }
  }
  const result = { version: manifest.version, file: path.basename(file), sha256: digest, files: files.size,
    checkedAt: new Date().toISOString(), runtimeDependencies: 'Vendored assets; no installed npm runtime dependencies',
    licenses: [...files.keys()].filter(name => /(?:LICENSE|NOTICES)/i.test(name)) };
  fs.writeFileSync(file + '.sha256', digest + '  ' + path.basename(file) + '\n');
  fs.writeFileSync(path.join(root, 'dist/package-validation.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'dist/sbom.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { timestamp: result.checkedAt, component: { type: 'application', name: manifest.name, version: manifest.version } }, components }, null, 2) + '\n');
  console.log(`Verified ${result.files} entries; SHA-256 ${digest}`); return result;
}
if (require.main === module) verify(process.argv[2] || path.join(__dirname, '../dist', `${require('../package.json').name}-${require('../package.json').version}.vsix`)).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { readZip, verify };
