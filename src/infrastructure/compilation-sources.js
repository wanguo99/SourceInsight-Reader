'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { preprocessorSymbols } = require('../document-symbols');
const { decodeSource } = require('./source-text');

// Tokenize arguments only. Never execute a compiler, shell or response file.
function words(command) {
  const result = []; let word = '', quote = '';
  for (let at = 0; at < command.length; at++) {
    const char = command[at];
    if (char === '\\' && quote !== "'" && /[\s"'\\]/.test(command[at + 1] || '')) { word += command[++at]; continue; }
    if (quote) { if (char === quote) quote = ''; else word += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (word) { result.push(word); word = ''; } }
    else word += char;
  }
  if (quote) throw new Error('编译命令包含未闭合引号');
  if (word) result.push(word); return result;
}
function options(args, directory) {
  const include = [], quote = [], system = [], after = [], forced = [];
  let sysroot;
  for (let at = 0; at < args.length; at++) if (args[at] === '--sysroot' || args[at] === '-isysroot') sysroot = args[++at]; else if (args[at].startsWith('--sysroot=')) sysroot = args[at].slice(10);
  for (let at = 0; at < args.length; at++) {
    const item = args[at];
    const match = /^(?:-I(.*)|-iquote(.*)|-isystem(.*)|-idirafter(.*)|-include(.*)|-imacros(.*))$/.exec(item);
    if (!match) continue;
    const index = match.slice(1).findIndex(value => value !== undefined), value = match[index + 1] || args[++at];
    if (!value) throw new Error('编译命令缺少头文件路径参数');
    const resolved = value.startsWith('=') && sysroot ? path.resolve(directory, sysroot, '.' + value.slice(1)) : path.resolve(directory, value);
    (index === 0 ? include : index === 1 ? quote : index === 2 ? system : index === 3 ? after : forced).push(index >= 4 ? value : resolved);
  }
  return { include: [...include, ...system, ...after], quote, forced, directory };
}
async function compilationSources(database, roots, check = () => {}, pathMappings = [], { encodings = [] } = {}) {
  check();
  const db = database.startsWith('file:') ? fileURLToPath(database) : database;
  const stat = await fs.stat(db);
  if (stat.size > 64 * 1024 * 1024) throw new Error('编译数据库超过 64 MiB，请生成当前模块的 compile_commands.json');
  const entries = JSON.parse((await fs.readFile(db, 'utf8')).replace(/^\uFEFF/, ''));
  if (!Array.isArray(entries)) throw new Error('compile_commands.json 必须是 JSON 数组');
  const within = (root, file) => { const relative = path.relative(root, file); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  roots = [...roots].sort((a, b) => b.length - a.length);
  const realRoots = new Map(await Promise.all(roots.map(async root => [root, await fs.realpath(root)])));
  const inside = file => roots.some(root => within(root, file));
  // Explicit mappings only: never infer ownership from matching basenames.
  if (!Array.isArray(pathMappings) || pathMappings.length > 32) throw new Error('路径映射必须是最多 32 项的数组');
  const absolute = value => {
    if (typeof value !== 'string' || !value) throw new Error('路径映射目录不能为空');
    const resolved = value.startsWith('file:') ? fileURLToPath(value) : value;
    if (!path.isAbsolute(resolved)) throw new Error('路径映射必须使用绝对目录');
    return path.resolve(resolved);
  };
  const mappings = pathMappings.map(item => ({ from: absolute(item?.from), to: absolute(item?.to) })).sort((a, b) => b.from.length - a.from.length);
  for (const mapping of mappings) {
    if (!inside(mapping.to)) throw new Error('映射目标必须位于当前工作区内');
    if (mappings.some(other => other !== mapping && other.from === mapping.from && other.to !== mapping.to)) throw new Error('同一构建目录不能映射到多个源码目录');
    const root = roots.find(root => within(root, mapping.to));
    if (!within(realRoots.get(root), await fs.realpath(mapping.to))) throw new Error('映射目标不能通过符号链接指向工作区外');
  }
  const remap = file => { const mapping = mappings.find(item => within(item.from, file)); return mapping ? path.resolve(mapping.to, path.relative(mapping.from, file)) : file; };
  let mappedSources = 0, missingSources = 0, unsupported = 0;
  const missingSourceFiles = [];

  const files = new Set(), visited = new Set(), groups = new Map(), statCache = new Map();
  const missing = new Set(); let outside = 0, invalid = 0, sources = 0;
  const exists = async (file, root) => {
    if (!within(root, file)) return false;
    const key = root + ':' + file;
    if (statCache.size > 50000) statCache.clear();
    if (!statCache.has(key)) statCache.set(key, await fs.realpath(file).then(async real => within(realRoots.get(root), real) && (await fs.stat(file)).isFile()).catch(() => false));
    return statCache.get(key);
  };
  const range = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } });
  const visit = async (source, config, group, root) => {
    const pending = [source];
    for (const name of config.forced) {
      let found;
      for (const directory of [config.directory, ...config.quote, ...config.include]) { const target = path.resolve(directory, name); if (await exists(target, root)) { found = target; break; } }
      if (found) pending.push(found); else if (missing.size < 20) missing.add(name);
    }
    while (pending.length) {
      check();
      const file = pending.pop(), key = group + ':' + file;
      if (visited.has(key) || !inside(file)) continue;
      visited.add(key);
      if (visited.size > 400000 || files.size > 100000) throw new Error('编译数据库依赖发现达到规模上限，请缩小编译数据库范围');
      if (!await exists(file, root)) { if (missing.size < 20) missing.add(file); continue; }
      files.add(pathToFileURL(file).toString());
      const info = await fs.stat(file); if (info.size > 16 * 1024 * 1024) continue;
      const encoding = encodings.find(value => value.root === root)?.encoding || 'utf8';
      let text;
      try { text = decodeSource(await fs.readFile(file), encoding); }
      catch (error) { throw new Error(`头文件依赖发现无法读取 ${file}：${error.message}`); }
      const includes = preprocessorSymbols(text, pathToFileURL(file).toString(), range, true);
      for (const symbol of includes) {
        const match = /^("([^"]+)"|<([^>]+)>)$/.exec(symbol.detail); if (!match) continue;
        const name = match[2] || match[3], directories = match[2] ? [path.dirname(file), ...config.quote, ...config.include] : config.include;
        let found;
        for (const directory of directories) { const target = path.resolve(directory, name); if (await exists(target, root)) { found = target; break; } }
        if (found) pending.push(found); else if (missing.size < 20) missing.add(name);
      }
    }
  };
  for (const entry of entries) {
    check();
    if (!entry || typeof entry.file !== 'string' || typeof entry.directory !== 'string') { invalid++; continue; }
    const directory = path.resolve(path.dirname(db), entry.directory), original = path.resolve(directory, entry.file), file = remap(original);
    if (!inside(file)) { outside++; continue; }
    if (!/\.(c|cc|cpp|cxx|c\+\+|h|hpp|hh|hxx)$/i.test(file)) { unsupported++; continue; }
    const args = Array.isArray(entry.arguments) && entry.arguments.every(value => typeof value === 'string') ? entry.arguments : typeof entry.command === 'string' ? words(entry.command) : undefined;
    if (!args) { invalid++; continue; }
    const root = roots.find(root => within(root, file));
    if (!await exists(file, root)) { missingSources++; if (missingSourceFiles.length < 20) missingSourceFiles.push({ recorded: original, mapped: file }); if (missing.size < 20) missing.add(file); continue; }
    const config = options(args, directory);
    config.include = config.include.map(remap); config.quote = config.quote.map(remap);
    config.forced = config.forced.map(name => path.isAbsolute(name) ? remap(name) : name);
    config.directory = remap(directory);
    const key = JSON.stringify(config);
    if (file !== original) mappedSources++;
    if (!groups.has(key)) groups.set(key, groups.size);
    sources++; await visit(file, config, groups.get(key), root);
  }
  if (!sources) throw new Error(`编译数据库没有可索引的工作区源文件（工作区外 ${outside} 项，无效 ${invalid} 项），请核对 directory/file；Buildroot 或独立构建目录请配置构建目录到源码目录的路径映射`);
  return { database: pathToFileURL(path.resolve(db)).toString(), files: [...files].sort(), sources, mappedSources, missingSources, missingSourceFiles, unsupported, outside, invalid, missing: [...missing] };
}
module.exports = { compilationSources, words, options };
