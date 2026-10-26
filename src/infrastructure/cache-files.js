'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { cacheDatabaseFiles, projectFolder } = require('./cache-layout');
const { cacheInUse, withCacheDeletion } = require('./cache-lease');

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}
async function regular(file) {
  try { const stat = await fs.lstat(file); return stat.isFile() && !stat.isSymbolicLink() ? stat : undefined; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function listCacheFiles(directories, legacy = []) {
  const result = [];
  const add = async (file, directory, kind) => {
    const stat = await regular(file); if (!stat) return;
    const files = [{ path: file, size: stat.size }];
    if (kind === 'sqlite') for (const suffix of ['-wal', '-shm']) { const extra = await regular(file + suffix); if (extra) files.push({ path: file + suffix, size: extra.size }); }
    let project = path.basename(path.dirname(file));
    if (kind === 'sqlite') try {
      const metadata = path.join(path.dirname(file), 'project.json'), info = await regular(metadata);
      if (info?.size < 8192) { const value = JSON.parse(await fs.readFile(metadata, 'utf8')); if (typeof value.project === 'string') project = value.project; }
    } catch (error) { /* A missing/broken label cannot block cache management. */ }
    result.push({ path: file, directory, kind, project, files, size: files.reduce((sum, value) => sum + value.size, 0),
      inode: String(stat.ino), device: String(stat.dev), inUse: kind === 'sqlite' && cacheInUse(file) });
  };
  for (const configured of new Set(directories.filter(Boolean))) {
    let directory; try { directory = await fs.realpath(configured); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of await cacheDatabaseFiles(directory)) await add(file, directory, 'sqlite');
  }
  for (const file of legacy) await add(file, path.dirname(file), 'legacy');
  return result.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
}
async function deleteCacheFile(entry) {
  const folder = path.dirname(entry.path), name = path.basename(entry.path);
  const legacy = /^[a-f0-9]{64}$/.test(path.basename(folder)) && [entry.directory, path.join(entry.directory, 'indexes')].includes(path.dirname(folder));
  const modern = path.basename(folder) === 'indexes' && projectFolder(path.basename(path.dirname(folder))) && path.dirname(path.dirname(folder)) === entry.directory;
  if (entry.kind === 'sqlite' ? name !== 'index.sqlite' || !(legacy || modern)
    : entry.kind !== 'legacy' || name !== 'c-index-v2.json' || folder !== entry.directory) throw new Error('无效缓存文件路径');
  if (entry.kind === 'sqlite' && (await fs.lstat(path.dirname(folder))).isSymbolicLink()) throw new Error('缓存目录已改变，请刷新列表');
  const directory = await fs.lstat(folder);
  if (directory.isSymbolicLink()) throw new Error('缓存目录已改变，请刷新列表');
  const current = await regular(entry.path);
  if (!current) return { missing: true };
  if (String(current.ino) !== entry.inode || String(current.dev) !== entry.device) throw new Error('缓存文件已改变，请刷新列表');
  return withCacheDeletion(entry.path, async () => {
    // Delete only this known database family; never recurse through the cache
    // directory or remove unknown files, reading notes or configuration backups.
    for (const suffix of entry.kind === 'sqlite' ? ['-wal', '-shm', ''] : ['']) {
      const file = entry.path + suffix, info = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('缓存文件已改变，请刷新列表');
      await fs.unlink(file);
    }
  });
}
module.exports = { listCacheFiles, deleteCacheFile, formatBytes };
