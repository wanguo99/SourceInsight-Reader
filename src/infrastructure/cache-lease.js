'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { threadId } = require('node:worker_threads');

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function readOwner(file) {
  try { const info = fs.lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return {}; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; return {}; }
}
function leases(file) {
  try { return fs.readdirSync(path.dirname(file)).filter(name => name.startsWith(path.basename(file) + '.lease-')).map(name => path.join(path.dirname(file), name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function cacheInUse(file) {
  for (const marker of leases(file)) {
    const owner = readOwner(marker); if (!owner) continue;
    if (alive(owner.pid)) return true;
  }
  // Older versions have no leases. Preserve their WAL/SHM files while their
  // connection state cannot be established, rather than risking live deletion.
  return ['-wal', '-shm'].some(suffix => fs.existsSync(file + suffix));
}
function guardBusy(file) { const owner = readOwner(file + '.deleting'); return owner && alive(owner.pid); }
function acquireCacheLease(file) {
  if (file === ':memory:') return () => {};
  if (guardBusy(file)) throw Object.assign(new Error('缓存正在删除，请稍后重试'), { code: 'INDEX_CACHE_DELETING' });
  const marker = `${file}.lease-${process.pid}-${threadId}-${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, threadId }), { flag: 'wx', mode: 0o600 });
  const release = () => { try { fs.unlinkSync(marker); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  if (guardBusy(file)) { release(); throw Object.assign(new Error('缓存正在删除，请稍后重试'), { code: 'INDEX_CACHE_DELETING' }); }
  return release;
}
async function withCacheDeletion(file, action) {
  const guard = file + '.deleting';
  try { fs.writeFileSync(guard, JSON.stringify({ pid: process.pid, threadId }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readOwner(guard);
    if (!owner || alive(owner.pid)) return { inUse: true };
    fs.unlinkSync(guard); return withCacheDeletion(file, action);
  }
  try {
    if (cacheInUse(file)) return { inUse: true };
    await action();
    for (const marker of leases(file)) { const owner = readOwner(marker); if (owner && !alive(owner.pid)) fs.unlinkSync(marker); }
    return { deleted: true };
  } finally { fs.unlinkSync(guard); }
}
async function releaseWorkerLeases(directories, ownerThread) {
  const prefix = `index.sqlite.lease-${process.pid}-${ownerThread}-`;
  for (const directory of directories) {
    let entries; try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const folder = path.join(directory, entry.name);
      for (const name of await fs.promises.readdir(folder)) if (name.startsWith(prefix)) await fs.promises.unlink(path.join(folder, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
module.exports = { acquireCacheLease, cacheInUse, withCacheDeletion, releaseWorkerLeases };
