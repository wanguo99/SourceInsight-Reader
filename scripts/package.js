'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function archivePackages(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const packages = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name.endsWith('.vsix'));
  if (!packages.length) return;
  const names = [];
  for (const entry of packages) {
    if (!entry.isFile()) throw new Error(`发布包不是普通文件，无法安全归档：${entry.name}`);
    names.push(entry.name);
    if (fs.existsSync(path.join(directory, entry.name + '.sha256'))) names.push(entry.name + '.sha256');
  }
  for (const name of ['package-validation.json', 'sbom.cdx.json']) if (fs.existsSync(path.join(directory, name))) names.push(name);
  const files = names.map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`归档文件不是普通文件：${name}`);
    return { name, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  });
  const createdAt = new Date().toISOString(), parent = path.join(directory, 'archive');
  fs.mkdirSync(parent, { recursive: true });
  const archive = fs.mkdtempSync(path.join(parent, createdAt.replace(/[:.]/g, '-') + '-'));
  const manifest = { createdAt, files, moved: [] };
  const record = () => fs.writeFileSync(path.join(archive, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  record();
  for (const file of files) {
    fs.renameSync(path.join(directory, file.name), path.join(archive, file.name));
    manifest.moved.push(file.name); record();
  }
  console.log(`Archived ${packages.length} packages: ${archive}`);
  return archive;
}

async function packageExtension(root = path.join(__dirname, '..'), overrides = {}) {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const directory = path.join(root, 'dist');
  archivePackages(directory);
  const staging = fs.mkdtempSync(path.join(directory, '.package-build-'));
  const filename = `${name}-${version}.vsix`, file = path.join(staging, filename), output = path.join(directory, filename);
  try {
    if (overrides.build) await overrides.build(file);
    else execFileSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--no-dependencies', '--allow-missing-repository', '--out', file], { cwd: root, stdio: 'inherit' });
    await (overrides.verify || require('./verify-package').verify)(file, root, true);
    fs.renameSync(file, output);
    fs.renameSync(file + '.sha256', output + '.sha256');
    return output;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

if (require.main === module) packageExtension().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { archivePackages, packageExtension };
