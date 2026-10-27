'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// A separate SQLite rollback-journal file is an OS-backed exclusive writer
// lock. Keep the transaction open; process/Worker termination releases it.
// Never unlink this file: replacing its inode could create two lock owners.
class ProjectIndexLock {
  constructor(file) { this.file = file + '.writer-lock'; }
  acquire() {
    if (this.db) return true;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); this.db = db; return true; }
    catch (error) { db.close(); if (/busy|locked/i.test(error.message)) return false; throw error; }
  }
  close() { if (this.db) { const db = this.db; this.db = undefined; db.close(); } }
}

// Requests contain only disk URIs, never unsaved text. Repeated requests for
// one file coalesce through atomic rename. Only the owner drains the inbox.
function requestUpdate(file, uri) {
  const directory = file + '.requests'; fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const crypto = require('node:crypto');
  const name = crypto.createHash('sha256').update(uri).digest('hex') + '.json';
  const temporary = path.join(directory, name + '.' + crypto.randomBytes(8).toString('hex'));
  try { fs.writeFileSync(temporary, JSON.stringify({ uri }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, path.join(directory, name)); }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function pendingUpdates(file) {
  const directory = file + '.requests';
  try {
    return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 128).flatMap(name => {
      const source = path.join(directory, name), item = source + '.' + process.pid + '.processing';
      try {
        fs.renameSync(source, item);
        const stat = fs.lstatSync(item); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return [];
        const value = JSON.parse(fs.readFileSync(item, 'utf8')); fs.unlinkSync(item);
        return typeof value.uri === 'string' ? [value.uri] : [];
      } catch (error) { return []; }
      finally { try { fs.unlinkSync(item); } catch {} }
    });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
module.exports = { ProjectIndexLock, requestUpdate, pendingUpdates };
