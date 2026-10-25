'use strict';
// Read-only source audit. --bindings also opens the cache repository (its TEMP
// activity tables/schema indexes may be updated), never the source project.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { decodeFacts, identifierAt, WIDTH } = require('../src/infrastructure/identifier-table');
const { withoutTrivia, cSourceProjection } = require('../src/infrastructure/c-source-projection');
const keywords = new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local defined __VA_OPT__'.split(' '));
const option = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
async function main() {
  const input = option('--database'), sourceRoot = option('--root');
  if (!input || !sourceRoot) throw new Error('Usage: node scripts/audit-index.js --root SOURCE --database index.sqlite [--bindings] [--output result.json]');
  const root = path.resolve(sourceRoot), database = new DatabaseSync(path.resolve(input), { readOnly: true });
  const result = { project: path.basename(root), sourceReadOnly: true, files: 0, macroDefinitions: 0, missingMacroDefinitions: 0,
    replacementIdentifiers: 0, missingReplacementOccurrences: 0, outOfOrderFiles: 0, implicitVariadicParameters: 0,
    missingMacros: [], missingOccurrences: [], bindings: {}, unresolvedDeclarations: [], failures: [] };
  let repository, index;
  try {
    if (process.argv.includes('--bindings')) {
      const { SqliteIndexRepository } = require('../src/infrastructure/sqlite-index-repository');
      const { CIndex } = require('../src/c-index');
      const project = database.prepare("SELECT value FROM meta WHERE key='project'").get().value;
      const parser = database.prepare("SELECT value FROM meta WHERE key='parser'").get().value;
      repository = new SqliteIndexRepository(path.dirname(path.dirname(path.resolve(input))), parser);
      await repository.open(undefined, false, { descriptors: database.prepare('SELECT uri,path FROM files').all().map(file => ({ ...file, project })) });
      index = new CIndex(repository); index.replace([...repository.files.values()]);
    }
    for (const row of database.prepare('SELECT uri,path,facts FROM files').iterate()) {
      const file = path.relative(root, row.path);
      if (file === '..' || file.startsWith('..' + path.sep) || path.isAbsolute(file)) continue;
      try {
        const facts = decodeFacts(JSON.parse(zlib.inflateRawSync(row.facts, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')));
        const source = fs.readFileSync(row.path, 'utf8'), code = withoutTrivia(facts.requiresSemantic ? source : cSourceProjection(source, { keepDirectives: true }));
        const starts = [0]; for (let at = 0; at < source.length; at++) if (source[at] === '\n') starts.push(at + 1);
        const point = at => { let lo = 0, hi = starts.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= at) lo = mid + 1; else hi = mid; } return { line: lo - 1, character: at - starts[lo - 1] }; };
        const macros = facts.symbols.filter(node => node.category === 'macro'); let logicalEnd = 0;
        for (const match of code.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm)) {
          if (match.index < logicalEnd) continue;
          const name = match[1], at = match.index + match[0].lastIndexOf(name), position = point(at);
          result.macroDefinitions++;
          if (!macros.some(node => node.name === name && node.selectionRange.start.line === position.line && node.selectionRange.start.character === position.character)) {
            result.missingMacroDefinitions++; if (result.missingMacros.length < 100) result.missingMacros.push({ file, name, line: position.line + 1 });
          }
          logicalEnd = code.indexOf('\n', at); if (logicalEnd < 0) logicalEnd = code.length;
          while (/\\[ \t]*\r?$/.test(code.slice(at, logicalEnd)) && logicalEnd < code.length) { const next = code.indexOf('\n', logicalEnd + 1); logicalEnd = next < 0 ? code.length : next; }
          const begin = at + name.length;
          for (const token of code.slice(begin, logicalEnd).matchAll(/[A-Za-z_]\w*|[0-9][\w.]*/g)) {
            if (/^[0-9]/.test(token[0]) || keywords.has(token[0])) continue;
            const where = point(begin + token.index); result.replacementIdentifiers++;
            if (identifierAt(facts, where)?.name !== token[0]) {
              result.missingReplacementOccurrences++; if (result.missingOccurrences.length < 100) result.missingOccurrences.push({ file, name: token[0], line: where.line + 1 });
            }
          }
        }
        const data = facts.identifierData;
        for (let at = WIDTH; at < data.length; at += WIDTH) if (data[at + 1] < data[at - WIDTH + 1] || data[at + 1] === data[at - WIDTH + 1] && data[at + 2] < data[at - WIDTH + 2]) { result.outOfOrderFiles++; break; }
        if (index) {
          const seen = new Set();
          const visit = nodes => { for (const node of nodes) {
            if (facts.requiresSemantic && !['macro', 'macroParameter'].includes(node.category)) continue;
            const id = `${node.selectionRange.start.line}:${node.selectionRange.start.character}`; if (seen.has(id)) continue; seen.add(id);
            if (node.category === 'macroParameter' && node.name === '__VA_ARGS__' && identifierAt(facts, node.selectionRange.start)?.name !== node.name) { result.implicitVariadicParameters++; continue; }
            const category = node.category === 'macro' ? 'macro' : node.category === 'macroParameter' ? 'macroParameter' : node.kind === 7 ? 'field' : node.kind === 11 ? 'function' : node.scope ? 'local' : node.kind === 12 ? 'global' : 'typeOrEnum';
            result.bindings[category] ||= { checked: 0, unresolved: 0 }; result.bindings[category].checked++;
            if (!index.definitions(row.uri, node.selectionRange.start).length) {
              result.bindings[category].unresolved++; if (result.unresolvedDeclarations.length < 100) result.unresolvedDeclarations.push({ file, name: node.name, category, line: node.selectionRange.start.line + 1 });
            }
            visit(node.children || []); visit(node.declaredType?.children || []);
          } };
          visit(facts.symbols); visit(facts.locals);
        }
        result.files++;
      } catch (error) { result.failures.push({ file, message: error.message }); }
    }
  } finally { repository?.close(); database.close(); }
  const json = JSON.stringify(result, null, 2) + '\n', output = option('--output');
  if (output) fs.writeFileSync(output, json); else process.stdout.write(json);
  if (result.failures.length || result.missingMacroDefinitions || result.missingReplacementOccurrences || result.outOfOrderFiles || Object.values(result.bindings).some(row => row.unresolved)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
