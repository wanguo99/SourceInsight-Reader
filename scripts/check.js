'use strict';
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (entry.name.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
for (const directory of ['src', 'media', 'scripts', 'test']) check(directory);
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
if (!existsSync(manifest.main)) throw new Error('Missing extension entry point');
const source = readFileSync('src/application/commands.js', 'utf8');
for (const command of manifest.contributes.commands) {
  const name = command.command.split('.').at(-1);
  if (!source.includes(`app.commands.add('${name}',`)) throw new Error(`Unregistered command: ${command.command}`);
}
const assets = JSON.parse(readFileSync('vendor/tree-sitter/manifest.json', 'utf8'));
for (const asset of assets) {
  const data = readFileSync(path.join('vendor/tree-sitter', asset.name));
  if (createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error(`Parser asset digest mismatch: ${asset.name}`);
}
console.log('Syntax, extension entry point and contributed commands: OK');
