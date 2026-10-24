'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { name, version } = require('../package.json');
fs.mkdirSync(path.join(__dirname, '../dist'), { recursive: true });
const cli = require.resolve('@vscode/vsce/vsce');
execFileSync(process.execPath, [cli, 'package', '--no-dependencies', '--allow-missing-repository',
  '--out', `dist/${name}-${version}.vsix`], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
require('./verify-package').verify(path.join(__dirname, '../dist', `${name}-${version}.vsix`), path.join(__dirname, '..'), true).catch(error => { console.error(error); process.exitCode = 1; });
