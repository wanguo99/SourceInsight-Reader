'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { encodeFacts, decodeFacts, WIDTH } = require('./identifier-table');
const { rankSymbols } = require('../domain/symbol-search');
const SCHEMA = 4, MAX_PAYLOAD = 64 * 1024 * 1024;
const encode = value => zlib.deflateRawSync(Buffer.from(JSON.stringify(value)), { level: 1 });
const decode = bytes => JSON.parse(zlib.inflateRawSync(bytes, { maxOutputLength: MAX_PAYLOAD }).toString('utf8'));
const identity = node => `${node.uri}:${node.selectionRange?.start.line ?? node.location?.range.start.line ?? 0}:${node.selectionRange?.start.character ?? node.location?.range.start.character ?? 0}:${node.name}`;

function decodeFileFacts(bytes, uri) {
  try {
    const value = decodeFacts(decode(bytes));
    if (value?.uri !== uri || !Array.isArray(value.symbols) || !Array.isArray(value.functions) || !Array.isArray(value.calls) ||
      !Array.isArray(value.locals) || (!Array.isArray(value.identifiers) && !(value.identifierData instanceof Int32Array))) throw new Error('Invalid file facts');
    return value;
  } catch (error) { throw Object.assign(new Error(`单文件索引缓存损坏：${uri}`), { code: 'INDEX_CACHE_RECORD' }); }
}

function databasePath(directory, project) {
  const normalized = process.platform === 'win32' ? project.toLowerCase() : project;
  return path.join(directory, crypto.createHash('sha256').update(normalized).digest('hex'), 'index.sqlite');
}

class IndexDatabase {
  constructor(file, project, parser, report = message => {}) {
    this.path = file; this.project = project; this.parser = parser; this.report = report; this.cache = new Map(); this.cacheBytes = 0; this.statements = new Map(); this.searchCache = new Map(); this.symbolRevision = 0; this.functionIds = new Map(); this.fileIds = new Map();
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { this.connect(); }
    catch (error) {
      this.db?.close();
      if (file === ':memory:' || !/not a database|malformed/i.test(error.message)) throw error;
      const backup = file + '.corrupt-' + Date.now(); fs.renameSync(file, backup);
      // These files belong to the same corrupt database, never another project.
      for (const suffix of ['-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, backup + suffix);
      report('索引数据库损坏，已保留备份并重建'); this.connect();
    }
  }
  connect() {
    this.statements.clear(); this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-4096;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (Number(version) > SCHEMA) throw new Error('索引数据库格式较新，请使用相应版本扩展');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY,uri TEXT NOT NULL UNIQUE,path TEXT NOT NULL,hash TEXT NOT NULL,stamp TEXT,metadata BLOB NOT NULL,facts BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS file_states(uri TEXT PRIMARY KEY,language TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS symbols(provider TEXT NOT NULL,uri TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,folded TEXT NOT NULL,role TEXT NOT NULL,line INTEGER NOT NULL,col INTEGER NOT NULL,end_line INTEGER NOT NULL,end_col INTEGER NOT NULL,data BLOB NOT NULL,kind INTEGER NOT NULL DEFAULT 12,container TEXT NOT NULL DEFAULT '',PRIMARY KEY(provider,uri,id,role));
      CREATE INDEX IF NOT EXISTS symbols_name ON symbols(provider,name,role);
      CREATE INDEX IF NOT EXISTS symbols_position ON symbols(uri,line,col);
      CREATE INDEX IF NOT EXISTS symbols_local ON symbols(uri,provider,role,name);
      CREATE TABLE IF NOT EXISTS occurrences(file_id INTEGER NOT NULL,name TEXT NOT NULL,line INTEGER NOT NULL,col INTEGER NOT NULL,end_line INTEGER NOT NULL,end_col INTEGER NOT NULL,namespace INTEGER NOT NULL,tag INTEGER NOT NULL,receiver_line INTEGER NOT NULL,receiver_col INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS occurrences_name ON occurrences(name,file_id);
      CREATE INDEX IF NOT EXISTS occurrences_position ON occurrences(file_id,line,col);
      CREATE TABLE IF NOT EXISTS graphs(id INTEGER PRIMARY KEY,graph_key TEXT NOT NULL UNIQUE,ready INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS function_keys(id INTEGER PRIMARY KEY,key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS edges(graph_id INTEGER NOT NULL,provider TEXT NOT NULL,file_id INTEGER NOT NULL,caller_id INTEGER NOT NULL,target_id INTEGER,name TEXT NOT NULL,line INTEGER NOT NULL,col INTEGER NOT NULL,data BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS edges_outgoing ON edges(graph_id,provider,caller_id);
      CREATE INDEX IF NOT EXISTS edges_incoming ON edges(graph_id,provider,target_id);
      CREATE INDEX IF NOT EXISTS edges_file ON edges(graph_id,provider,file_id);
      CREATE TABLE IF NOT EXISTS snapshots(uri TEXT NOT NULL,provider TEXT NOT NULL,kind TEXT NOT NULL,query_key TEXT NOT NULL,build_key TEXT NOT NULL,hash TEXT NOT NULL,quality TEXT NOT NULL,updated INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(uri,provider,kind,query_key,build_key));
      CREATE INDEX IF NOT EXISTS snapshots_updated ON snapshots(updated);
      CREATE TEMP TABLE IF NOT EXISTS active_files(uri TEXT PRIMARY KEY);
      PRAGMA user_version=${SCHEMA};
    `);
    if (!this.db.prepare('PRAGMA table_info(files)').all().some(column => column.name === 'id')) this.transaction(() => {
      this.db.exec(`CREATE TABLE files_v3(id INTEGER PRIMARY KEY,uri TEXT NOT NULL UNIQUE,path TEXT NOT NULL,hash TEXT NOT NULL,stamp TEXT,metadata BLOB NOT NULL,facts BLOB NOT NULL);
        INSERT INTO files_v3 SELECT rowid,uri,path,hash,stamp,metadata,facts FROM files;
        DROP TABLE files; ALTER TABLE files_v3 RENAME TO files;`);
    });
    if (!this.db.prepare('PRAGMA table_info(symbols)').all().some(column => column.name === 'kind')) this.transaction(() => {
      this.db.exec("ALTER TABLE symbols ADD COLUMN kind INTEGER NOT NULL DEFAULT 12; ALTER TABLE symbols ADD COLUMN container TEXT NOT NULL DEFAULT '';");
      const update = this.db.prepare('UPDATE symbols SET kind=?,container=? WHERE provider=? AND uri=? AND id=? AND role=?');
      for (const row of this.db.prepare('SELECT provider,uri,id,role,data FROM symbols').all()) {
        const node = decode(row.data); update.run(node.kind, node.containerName || '', row.provider, row.uri, row.id, row.role);
      }
    });
    if (this.db.prepare('PRAGMA table_info(occurrences)').all().some(column => column.name === 'uri')) {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE occurrences_v3(file_id INTEGER NOT NULL,name TEXT NOT NULL,line INTEGER NOT NULL,col INTEGER NOT NULL,end_line INTEGER NOT NULL,end_col INTEGER NOT NULL,namespace INTEGER NOT NULL,tag INTEGER NOT NULL,receiver_line INTEGER NOT NULL,receiver_col INTEGER NOT NULL);
          INSERT INTO occurrences_v3 SELECT f.rowid,o.name,o.line,o.col,o.end_line,o.end_col,o.namespace,o.tag,o.receiver_line,o.receiver_col FROM occurrences o JOIN files f ON f.uri=o.uri;
          DROP TABLE occurrences; ALTER TABLE occurrences_v3 RENAME TO occurrences;
          CREATE INDEX occurrences_name ON occurrences(name,file_id);
          CREATE INDEX occurrences_position ON occurrences(file_id,line,col);`);
      });
      this.db.exec('VACUUM');
    }
    if (!this.db.prepare('PRAGMA table_info(graphs)').all().some(column => column.name === 'id')) this.transaction(() => {
      this.db.exec(`CREATE TABLE graphs_v4(id INTEGER PRIMARY KEY,graph_key TEXT NOT NULL UNIQUE,ready INTEGER NOT NULL,updated INTEGER NOT NULL);
        INSERT INTO graphs_v4 SELECT rowid,graph_key,ready,updated FROM graphs;
        DROP TABLE graphs; ALTER TABLE graphs_v4 RENAME TO graphs;`);
    });
    if (this.db.prepare('PRAGMA table_info(edges)').all().some(column => column.name === 'graph_key')) this.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO function_keys(key) SELECT caller FROM edges;
        INSERT OR IGNORE INTO function_keys(key) SELECT target FROM edges WHERE target IS NOT NULL;
        CREATE TABLE edges_v4(graph_id INTEGER NOT NULL,provider TEXT NOT NULL,file_id INTEGER NOT NULL,caller_id INTEGER NOT NULL,target_id INTEGER,name TEXT NOT NULL,line INTEGER NOT NULL,col INTEGER NOT NULL,data BLOB NOT NULL);
        INSERT INTO edges_v4 SELECT g.id,e.provider,f.id,c.id,t.id,e.name,e.line,e.col,e.data FROM edges e
          JOIN graphs g ON g.graph_key=e.graph_key JOIN files f ON f.uri=e.file JOIN function_keys c ON c.key=e.caller LEFT JOIN function_keys t ON t.key=e.target;
        DROP TABLE edges; ALTER TABLE edges_v4 RENAME TO edges;
        CREATE INDEX edges_outgoing ON edges(graph_id,provider,caller_id); CREATE INDEX edges_incoming ON edges(graph_id,provider,target_id); CREATE INDEX edges_file ON edges(graph_id,provider,file_id);`);
    });
    const stored = this.meta('project');
    if (stored && stored !== this.project) throw new Error('索引数据库工程身份不匹配，拒绝覆盖');
    this.setMeta('project', this.project);
    if (this.meta('parser') !== this.parser) this.transaction(() => {
      this.db.exec("DELETE FROM files; DELETE FROM symbols WHERE provider='local'; DELETE FROM occurrences; DELETE FROM edges WHERE provider='local'; DELETE FROM function_keys; DELETE FROM graphs; DELETE FROM file_states;");
      this.setMeta('parser', this.parser); this.setMeta('graphReady', '0'); this.bump();
    });
  }
  statement(sql) { if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql)); return this.statements.get(sql); }
  meta(key) { return this.statement('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.statement('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, String(value)); }
  bump() { this.setMeta('revision', Number(this.meta('revision') || 0) + 1); this.setMeta('graphReady', '0'); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  activate(uris) { this.searchCache.clear(); this.transaction(() => { this.db.exec('DELETE FROM temp.active_files'); const insert = this.statement('INSERT OR IGNORE INTO temp.active_files VALUES(?)'); for (const uri of uris) insert.run(uri); }); }
  include(uri) { this.statement('INSERT OR IGNORE INTO temp.active_files VALUES(?)').run(uri); this.searchCache.clear(); }
  exclude(uri) { this.statement('DELETE FROM temp.active_files WHERE uri=?').run(uri); this.searchCache.clear(); }
  state(uri, language, status, message = '') { this.searchCache.clear(); this.statement('INSERT OR REPLACE INTO file_states VALUES(?,?,?,?,?)').run(uri, language, status, message, Date.now()); }
  states() { return this.statement('SELECT s.* FROM file_states s JOIN temp.active_files a ON a.uri=s.uri').all(); }
  metadata() {
    return [...this.metadataRecords()];
  }
  *metadataRecords() {
    for (const row of this.statement('SELECT f.uri,f.metadata FROM files f JOIN temp.active_files a ON a.uri=f.uri').iterate()) {
      try {
        const value = decode(row.metadata);
        if (value.uri !== row.uri || typeof value.path !== 'string' || !Array.isArray(value.functions) || !Array.isArray(value.includes) || !Array.isArray(value.macros)) throw new Error('Invalid file metadata');
        yield value;
      } catch (error) { this.delete(row.uri, true); this.state(row.uri, 'unknown', 'cacheRecovery', error.message); this.report(`单文件索引缓存已损坏，将重新解析：${row.uri}`); }
    }
  }
  fileMetadata(uri) { const row = this.statement('SELECT metadata FROM files WHERE uri=?').get(uri); return row ? decode(row.metadata) : undefined; }
  updateMetadata(uri, metadata) {
    this.statement('UPDATE files SET stamp=?,metadata=? WHERE uri=? AND hash=?').run(JSON.stringify(metadata.stamp || null), encode(metadata), uri, metadata.hash);
  }
  fileFacts(uri) {
    const cached = this.cache.get(uri); if (cached) { this.cache.delete(uri); this.cache.set(uri, cached); return cached.value; }
    const row = this.statement('SELECT facts FROM files WHERE uri=?').get(uri); if (!row) return undefined;
    const value = decodeFileFacts(row.facts, uri);
    const bytes = Number(row.facts.byteLength) * 12 + (value.identifierData?.byteLength || 0);
    if (bytes < 32 * 1024 * 1024) {
      while (this.cache.size && (this.cache.size >= 4 || this.cacheBytes + bytes > 32 * 1024 * 1024)) { const first = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(first).bytes; this.cache.delete(first); }
      this.cache.set(uri, { value, bytes }); this.cacheBytes += bytes;
    }
    return value;
  }
  evict(uri) { const old = this.cache.get(uri); if (old) this.cacheBytes -= old.bytes; this.cache.delete(uri); }
  publish(snapshot) {
    if (!['local', 'languageService'].includes(snapshot.provider) || typeof snapshot.uri !== 'string' || typeof snapshot.hash !== 'string') throw new Error('无效索引提供者快照');
    if (snapshot.dirty) return { persisted: false, reason: 'dirty' };
    return this.transaction(() => {
      if (snapshot.facts) { this.writeFacts(snapshot.facts); return { persisted: true }; }
      if (snapshot.kind === 'symbols' && !snapshot.facts) {
        const file = this.statement('SELECT hash FROM files WHERE uri=?').get(snapshot.uri);
        if (file && file.hash !== snapshot.hash) return { persisted: false, reason: 'stale' };
        this.writeSymbols(snapshot.uri, snapshot.provider, snapshot.data || []);
      }
      if (snapshot.provider === 'languageService' && !this.statement('SELECT uri FROM files WHERE uri=?').get(snapshot.uri)) {
        this.state(snapshot.uri, path.extname(snapshot.uri).slice(1) || 'unknown', 'semanticObserved', '语言服务按需采集；未执行全工程语义遍历');
      }
      const build = snapshot.buildKey || '';
      this.statement('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(snapshot.uri, snapshot.provider, snapshot.kind, snapshot.queryKey || '', build,
        snapshot.hash, snapshot.quality || 'partial', Date.now(), encode(snapshot.data || []));
      // Query observations are a bounded cache; file facts and graph are not.
      this.db.exec('DELETE FROM snapshots WHERE rowid IN (SELECT rowid FROM snapshots ORDER BY updated DESC LIMIT -1 OFFSET 4096)');
      return { persisted: true };
    });
  }
  writeFacts(file) {
    const old = this.statement('SELECT hash,stamp FROM files WHERE uri=?').get(file.uri);
    if (old && old.hash !== file.hash) this.statement("DELETE FROM symbols WHERE uri=? AND provider='languageService'").run(file.uri);
    const { symbols, locals, calls, identifierData, identifierNames, ...metadata } = file;
    metadata.objectNames = file.symbols.filter(node => node.kind === 12).map(node => node.name);
    metadata.symbolCount = file.symbols.length; metadata.callNames = [...new Set(file.calls.map(call => call.name))];
    this.statement('INSERT INTO files(uri,path,hash,stamp,metadata,facts) VALUES(?,?,?,?,?,?) ON CONFLICT(uri) DO UPDATE SET path=excluded.path,hash=excluded.hash,stamp=excluded.stamp,metadata=excluded.metadata,facts=excluded.facts').run(file.uri, file.path, file.hash, JSON.stringify(file.stamp || null), encode(metadata), encode(encodeFacts(file)));
    this.writeSymbols(file.uri, 'local', file.symbols, file.locals);
    const fileId = this.statement('SELECT rowid AS id FROM files WHERE uri=?').get(file.uri).id;
    this.fileIds.set(file.uri, fileId);
    this.statement('DELETE FROM occurrences WHERE file_id=?').run(fileId);
    const insert = this.statement('INSERT INTO occurrences VALUES(?,?,?,?,?,?,?,?,?,?)');
    const data = file.identifierData || [], names = file.identifierNames || [];
    for (let at = 0; at < data.length; at += WIDTH) insert.run(fileId, names[data[at]], ...Array.from(data.subarray(at + 1, at + WIDTH)));
    // Legacy uncompressed facts remain accepted during migration/tests.
    for (const token of file.identifiers || []) insert.run(fileId, token.name, token.range.start.line, token.range.start.character, token.range.end.line, token.range.end.character,
      ['value','type','field','tag'].indexOf(token.namespace || 'value'), ['', 'struct_specifier','union_specifier','enum_specifier'].indexOf(token.type || ''), token.receiver?.line ?? -1, token.receiver?.character ?? -1);
    this.state(file.uri, file.language || 'c', file.requiresSemantic ? 'outline' : file.declarationsOnly ? 'limited' : file.hasErrors ? 'partial' : 'ready');
    this.evict(file.uri);
    if (!old || old.hash !== file.hash || old.stamp !== JSON.stringify(file.stamp || null)) this.bump();
  }
  writeSymbols(uri, provider, nodes, locals = []) {
    this.symbolRevision++; this.searchCache.clear();
    this.statement('DELETE FROM symbols WHERE uri=? AND provider=?').run(uri, provider);
    const insert = this.statement('INSERT OR REPLACE INTO symbols VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const visit = (values, role, inheritedScope, container = '') => { for (const node of values) {
      const selection = node.selectionRange || node.location?.range || node.range; if (!selection?.start || !selection.end || typeof node.name !== 'string') continue;
      const value = { ...node, uri, ...(inheritedScope && !node.scope ? { scope: inheritedScope } : {}) };
      insert.run(provider, uri, identity(value), value.name, value.name.toLowerCase(), role, selection.start.line, selection.start.character, selection.end.line, selection.end.character, encode(value), value.kind, container);
      visit(node.children || [], role === 'local' ? 'local' : 'member', node.scope || inheritedScope, node.name);
      visit(node.declaredType?.children || [], 'member', node.scope || inheritedScope, node.name);
    } };
    visit(nodes, 'top', undefined); visit(locals, 'local', undefined);
  }
  findSymbols(name, role, uri) {
    let sql = 'SELECT s.data FROM symbols s JOIN temp.active_files a ON a.uri=s.uri WHERE s.provider=\'local\' AND s.name=?';
    const values = [name]; if (role) { sql += ' AND s.role=?'; values.push(role); } if (uri) { sql += ' AND s.uri=?'; values.push(uri); }
    return this.statement(sql).all(...values).map(row => decode(row.data));
  }
  symbolAt(uri, point) { return this.statement("SELECT data FROM symbols WHERE provider='local' AND uri=? AND line=? AND col<=? AND end_line=? AND end_col>? LIMIT 64").all(uri,point.line,point.character,point.line,point.character).map(row => decode(row.data)); }
  identifierAt(uri, point) {
    const row = this.statement('SELECT * FROM occurrences WHERE file_id=(SELECT rowid FROM files WHERE uri=?) AND line=? AND col<=? AND (end_line>? OR end_col>?) ORDER BY col DESC LIMIT 1').get(uri, point.line, point.character, point.line, point.character);
    return row && this.token(row);
  }
  token(row) { return { name: row.name, range: { start: { line: row.line, character: row.col }, end: { line: row.end_line, character: row.end_col } },
    namespace: ['value','type','field','tag'][row.namespace], type: ['', 'struct_specifier','union_specifier','enum_specifier'][row.tag],
    ...(row.receiver_line >= 0 ? { receiver: { line: row.receiver_line, character: row.receiver_col } } : {}) }; }
  *occurrences(name) { for (const row of this.statement('SELECT f.uri,o.* FROM occurrences o JOIN files f ON f.rowid=o.file_id JOIN temp.active_files a ON a.uri=f.uri WHERE name=?').iterate(name)) yield { uri: row.uri, ...this.token(row) }; }
  search(query, limit = 1000) {
    const version = `${this.statement('PRAGMA data_version').get().data_version}:${this.symbolRevision}`, cacheKey = JSON.stringify([version, query, limit]);
    if (this.searchCache.has(cacheKey)) return this.searchCache.get(cacheKey);
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const clauses = terms.map(() => 's.folded LIKE ? ESCAPE \'\\\'');
    const patterns = terms.map(term => '%' + [...term].map(char => /[%_\\]/.test(char) ? '\\' + char : char).join('%') + '%');
    const rows = this.statement(`SELECT s.name,s.uri,s.kind,s.container,s.line,s.col,s.end_line,s.end_col FROM symbols s JOIN temp.active_files a ON a.uri=s.uri LEFT JOIN file_states state ON state.uri=s.uri WHERE s.role IN ('top','member') AND (state.status IS NULL OR state.status IN ('ready','partial','limited','outline','semanticObserved')) ${clauses.length ? 'AND '+clauses.join(' AND ') : ''} ORDER BY s.provider='languageService' DESC,s.name,s.uri LIMIT 12000`).all(...patterns);
    const unique = new Map(); for (const row of rows) {
      const id = `${row.uri}:${row.line}:${row.col}:${row.name}`;
      if (!unique.has(id)) unique.set(id, { name: row.name, kind: row.kind, uri: row.uri, range: { start: { line: row.line, character: row.col }, end: { line: row.end_line, character: row.end_col } }, containerName: row.container });
    }
    const result = rankSymbols([...unique.values()], query, limit);
    if (this.searchCache.size >= 32) this.searchCache.delete(this.searchCache.keys().next().value);
    this.searchCache.set(cacheKey, result); return result;
  }
  read(snapshot) {
    const row = this.statement('SELECT payload,quality,updated FROM snapshots WHERE uri=? AND provider=? AND kind=? AND query_key=? AND build_key=? AND hash=?')
      .get(snapshot.uri, snapshot.provider, snapshot.kind, snapshot.queryKey || '', snapshot.buildKey || '', snapshot.hash);
    return row && { data: decode(row.payload), quality: row.quality, updated: row.updated };
  }
  delete(uri, localOnly = false) { this.transaction(() => {
    this.symbolRevision++; this.searchCache.clear();
    this.statement('DELETE FROM occurrences WHERE file_id=(SELECT id FROM files WHERE uri=?)').run(uri);
    this.statement('UPDATE graphs SET ready=0 WHERE id IN (SELECT graph_id FROM edges WHERE file_id=(SELECT id FROM files WHERE uri=?))').run(uri);
    this.statement('DELETE FROM edges WHERE file_id=(SELECT id FROM files WHERE uri=?)').run(uri); this.fileIds.delete(uri);
    if (localOnly) {
      this.statement('DELETE FROM files WHERE uri=?').run(uri);
      this.statement("DELETE FROM symbols WHERE uri=? AND provider='local'").run(uri);
      this.statement("DELETE FROM snapshots WHERE uri=? AND provider='local'").run(uri);
      this.evict(uri); this.bump(); return;
    }
    for (const table of ['files','file_states','symbols','snapshots']) this.statement(`DELETE FROM ${table} WHERE uri=?`).run(uri);
    this.evict(uri); this.bump();
  }); }
  graphReady(key) { return Boolean(this.statement('SELECT ready FROM graphs WHERE graph_key=?').get(key)?.ready); }
  beginGraph(key, previous, affected) {
    this.graphWrites = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statement('INSERT INTO graphs(graph_key,ready,updated) VALUES(?,0,?) ON CONFLICT(graph_key) DO UPDATE SET ready=0,updated=excluded.updated').run(key, Date.now());
      this.graphId = this.statement('SELECT id FROM graphs WHERE graph_key=?').get(key).id;
      this.statement('DELETE FROM edges WHERE graph_id=?').run(this.graphId);
      if (previous && affected) {
        this.statement('INSERT INTO edges SELECT ?,provider,file_id,caller_id,target_id,name,line,col,data FROM edges WHERE graph_id=(SELECT id FROM graphs WHERE graph_key=?)').run(this.graphId, previous);
        for (const uri of affected) this.statement('DELETE FROM edges WHERE graph_id=? AND file_id=(SELECT id FROM files WHERE uri=?)').run(this.graphId, uri);
      }
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  functionId(key) {
    if (!key) return null;
    if (!this.functionIds.has(key)) {
      this.statement('INSERT OR IGNORE INTO function_keys(key) VALUES(?)').run(key);
      if (this.functionIds.size >= 100000) this.functionIds.clear();
      this.functionIds.set(key, this.statement('SELECT id FROM function_keys WHERE key=?').get(key).id);
    }
    return this.functionIds.get(key);
  }
  addEdge(key, edge) {
    if (!this.fileIds.has(edge.file)) this.fileIds.set(edge.file, this.statement('SELECT id FROM files WHERE uri=?').get(edge.file)?.id);
    // Volatile graphs have no durable file rows: use the repository's active
    // URI directory as a session-only integer dictionary.
    if (!this.fileIds.get(edge.file) && this.path === ':memory:') {
      const id = this.fileIds.size + 1; this.fileIds.set(edge.file, id);
      this.statement('INSERT OR IGNORE INTO files(id,uri,path,hash,metadata,facts) VALUES(?,?,?,?,?,?)').run(id, edge.file, edge.file, '', encode({}), encode({}));
    }
    this.statement('INSERT INTO edges VALUES(?,?,?,?,?,?,?,?,?)').run(this.graphId, 'local', this.fileIds.get(edge.file), this.functionId(edge.caller), this.functionId(edge.targets[0]), edge.name, edge.range.start.line, edge.range.start.character, encode(edge));
    // Unfinished graph generations remain invisible across connections.
    if (++this.graphWrites % 2048 === 0) this.db.exec('COMMIT; BEGIN IMMEDIATE');
  }
  endGraph(key, commit = true) {
    if (commit) this.statement('UPDATE graphs SET ready=1 WHERE graph_key=?').run(key);
    this.db.exec(commit ? 'COMMIT' : 'ROLLBACK');
    if (!commit) { this.functionIds.clear(); this.fileIds.clear(); }
    if (commit) {
      try { this.transaction(() => {
        this.db.exec('DELETE FROM graphs WHERE graph_key IN (SELECT graph_key FROM graphs ORDER BY updated DESC LIMIT -1 OFFSET 3); DELETE FROM edges WHERE graph_id NOT IN (SELECT id FROM graphs);');
      }); } catch (error) { this.report(`旧调用图清理延后：${error.message}`); }
    }
  }
  edgeList(key, id, incoming) {
    return this.statement(`SELECT e.data FROM edges e JOIN files f ON f.id=e.file_id JOIN temp.active_files a ON a.uri=f.uri WHERE graph_id=(SELECT id FROM graphs WHERE graph_key=?) AND provider='local' AND ${incoming ? 'target_id' : 'caller_id'}=(SELECT id FROM function_keys WHERE key=?)`).all(key, id).map(row => decode(row.data));
  }
  edgeCount(key) { return Number(this.statement("SELECT count(*) n FROM edges e JOIN files f ON f.id=e.file_id JOIN temp.active_files a ON a.uri=f.uri WHERE graph_id=(SELECT id FROM graphs WHERE graph_key=?) AND provider='local'").get(key).n); }
  flush() { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); }
  close() { this.cache.clear(); this.cacheBytes = 0; this.db.close(); }
}
module.exports = { IndexDatabase, databasePath, identity, decodeFileFacts, SCHEMA };
