'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { relativeUriPath } = require('../resources');
const { decodeFileFacts, SCHEMA } = require('./index-database');
const { acquireCacheLease } = require('./cache-lease');

function closeCacheReader(reader, file, release) {
  try {
    reader?.close();
    // SQLite leaves empty WAL/SHM files after a read-only connection closes.
    // A short normal connection lets SQLite perform its own last-close cleanup;
    // it changes no facts and leaves files alone if another connection is open.
    if (reader && release) {
      let cleanup;
      try { cleanup = new DatabaseSync(file); cleanup.exec('PRAGMA busy_timeout=0'); cleanup.prepare('PRAGMA schema_version').get(); }
      catch (error) { /* Optional cleanup must not make cache reuse fail. */ }
      finally { try { cleanup?.close(); } catch (error) { /* Keep the lease release unconditional. */ } }
    }
  } finally { release?.(); }
}

// Reuse syntax work for the same files, never another project's bindings.
// Discovery retains URI mappings only; at most one source connection and one
// decompressed file are needed while the destination is populated.
class InheritedIndexCache {
  constructor(directory, parser, report) { this.directory = directory; this.parser = parser; this.report = report; this.entries = new Map(); }
  async discover(descriptors) {
    this.close();
    const needed = new Map(descriptors.filter(file => file.project && /^[a-z][\w+.-]*:\/\//i.test(file.project)).map(file => [file.uri, file]));
    if (!needed.size) return;
    let directories;
    try { directories = await fs.readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') this.report(`父子目录索引复用不可用，将正常解析：${error.message}`); return; }
    const projects = [...new Set([...needed.values()].map(file => file.project))];
    const deadline = Date.now() + 2000;
    for (const entry of directories) {
      if (Date.now() >= deadline) { this.report('父子目录缓存发现达到时间预算，其余文件将正常解析'); break; }
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const file = path.join(this.directory, entry.name, 'index.sqlite'); let database, release;
      try {
        release = acquireCacheLease(file);
        database = new DatabaseSync(file, { readOnly: true }); database.exec('PRAGMA busy_timeout=100');
        if (Number(database.prepare('PRAGMA user_version').get().user_version) !== SCHEMA) continue;
        const meta = database.prepare('SELECT value FROM meta WHERE key=?');
        const project = meta.get('project')?.value;
        if (!project || meta.get('parser')?.value !== this.parser) continue;
        const related = new Set(projects.filter(target => target !== project &&
          (relativeUriPath(target, project) !== undefined || relativeUriPath(project, target) !== undefined)));
        if (!related.size) continue;
        for (const row of database.prepare('SELECT uri FROM files').iterate()) {
          if (Date.now() >= deadline) break;
          const target = needed.get(row.uri);
          if (!target || !related.has(target.project) || relativeUriPath(project, row.uri) === undefined || relativeUriPath(target.project, row.uri) === undefined) continue;
          const previous = this.entries.get(row.uri);
          if (!previous || project.length > previous.project.length) this.entries.set(row.uri, { file, project });
        }
      } catch (error) {
        // A locked, corrupt, old or concurrently removed source cache is only
        // an optional optimization. It must not make the new project fail.
      } finally { closeCacheReader(database, file, release); }
    }
  }
  take(descriptor) {
    const candidate = this.entries.get(descriptor.uri); if (!candidate) return undefined;
    this.entries.delete(descriptor.uri);
    try {
      if (this.readerPath !== candidate.file) {
        closeCacheReader(this.reader, this.readerPath, this.releaseReader); this.releaseReader = undefined; this.reader = undefined; this.readerPath = undefined;
        this.releaseReader = acquireCacheLease(candidate.file);
        this.reader = new DatabaseSync(candidate.file, { readOnly: true }); this.reader.exec('PRAGMA busy_timeout=100'); this.readerPath = candidate.file;
        this.meta = this.reader.prepare('SELECT value FROM meta WHERE key=?');
        this.facts = this.reader.prepare('SELECT hash,stamp,facts FROM files WHERE uri=?');
      }
      if (this.meta.get('parser')?.value !== this.parser || this.meta.get('project')?.value !== candidate.project) return undefined;
      const row = this.facts.get(descriptor.uri); if (!row) return undefined;
      const value = decodeFileFacts(row.facts, descriptor.uri);
      if (value.streamedDirectives) return undefined;
      if (value.hash !== row.hash) return undefined;
      const result = { ...value, project: descriptor.project, stamp: JSON.parse(String(row.stamp || 'null')), scopeKey: descriptor.scopeKey, indexExclude: descriptor.indexExclude };
      Object.defineProperty(result, '_inherited', { value: true }); return result;
    } catch (error) { closeCacheReader(this.reader, this.readerPath, this.releaseReader); this.reader = undefined; this.readerPath = undefined; this.releaseReader = undefined;
      this.report(`父子目录单文件缓存不可用，将重新解析：${descriptor.uri} · ${error.message}`); return undefined; }
  }
  close() { closeCacheReader(this.reader, this.readerPath, this.releaseReader); this.reader = undefined; this.readerPath = undefined; this.releaseReader = undefined; this.entries.clear(); }
}
module.exports = { InheritedIndexCache };
