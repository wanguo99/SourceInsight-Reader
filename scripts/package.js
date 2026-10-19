'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');
fs.mkdirSync(path.join(__dirname, '../dist'), { recursive: true });
const cli = require.resolve('@vscode/vsce/vsce');
execFileSync(process.execPath, [cli, 'package', '--no-dependencies', '--allow-missing-repository',
  '--out', `dist/source-insight-inspired-${version}.vsix`], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
