'use strict';
// Enumerate files in Node, rather than relying on shell wildcard expansion on Windows.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'all';
const files = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js'))
  .filter(name => mode === 'unit' ? name !== 'clangd.test.js' : mode === 'clangd' ? name === 'clangd.test.js' : true)
  .map(name => path.join(root, 'test', name));
const result = spawnSync(process.execPath, ['--test', '--experimental-test-isolation=none', ...files], {
  cwd: root, stdio: 'inherit', env: { ...process.env, SOURCEINSIGHT_READER_REQUIRE_CLANGD: mode === 'clangd' ? '1' : process.env.SOURCEINSIGHT_READER_REQUIRE_CLANGD || '' }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
