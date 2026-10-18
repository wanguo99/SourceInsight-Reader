'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');
const root = path.join(__dirname, '..');
const defaultDirectory = process.platform === 'linux' ? '/home/guohao/dist-vs-plugin' : path.join(root, 'dist');
const outputDirectory = path.resolve(process.env.SOURCE_READER_DIST_DIR || defaultDirectory);
fs.mkdirSync(outputDirectory, { recursive: true });
const outputFile = path.join(outputDirectory, `source-reader-${version}.vsix`);
const cli = require.resolve('@vscode/vsce/vsce');
execFileSync(process.execPath, [cli, 'package', '--no-dependencies', '--allow-missing-repository', '--no-rewrite-relative-links',
  '--out', outputFile], { cwd: root, stdio: 'inherit' });
