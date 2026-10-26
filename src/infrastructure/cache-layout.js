'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
function projectCacheName(project) {
  const normalized = process.platform === 'win32' ? project.toLowerCase() : project;
  let label;
  try { label = decodeURIComponent(new URL(project).pathname).split('/').filter(Boolean).pop(); } catch { label = project; }
  label = (label || 'workspace').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 32) || 'workspace';
  return `${label}--${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}
function projectStorageDirectory(directory, project) { return path.join(directory, projectCacheName(project)); }
const projectFolder = name => /--[a-f0-9]{32}$/.test(name);
// Recognize only our own layouts. Never traverse links or unrelated folders.
async function cacheDatabaseFiles(directory) {
  const files = [];
  for (const base of [directory, path.join(directory, 'indexes')]) {
    try {
      const info = await (base === directory ? fs.stat(base) : fs.lstat(base));
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      for (const entry of await fs.readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (/^[a-f0-9]{64}$/.test(entry.name)) files.push(path.join(base, entry.name, 'index.sqlite'));
        else if (base === directory && projectFolder(entry.name)) {
          const folder = path.join(base, entry.name, 'indexes');
          try { const info = await fs.lstat(folder); if (info.isDirectory() && !info.isSymbolicLink()) files.push(path.join(folder, 'index.sqlite')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}
module.exports = { projectCacheName, projectStorageDirectory, projectFolder, cacheDatabaseFiles };
