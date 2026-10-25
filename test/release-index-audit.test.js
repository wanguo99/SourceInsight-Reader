'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createParser, parseC } = require('../src/c-parser');
const { parseCpp } = require('../src/cpp-outline');
const { CIndex } = require('../src/c-index');
const { identifierAt, WIDTH } = require('../src/infrastructure/identifier-table');
const { SqliteIndexRepository } = require('../src/infrastructure/sqlite-index-repository');
const { preprocessorFacts } = require('../src/infrastructure/preprocessor-facts');
let parser, cpp;
test.before(async () => { parser = await createParser(); cpp = await createParser('cpp'); });
test.after(() => { parser.delete(); cpp.delete(); });
function fixture(sources) {
  const facts = Object.entries(sources).map(([file, source]) => ({ ...(file.endsWith('.cpp') ? parseCpp(cpp, source, 'file://' + file, file) : parseC(parser, source, 'file://' + file, file)), project: 'file:///' + file.split('/')[1] }));
  const index = new CIndex(); index.replace(facts);
  const at = (file, text, last = false) => {
    const source = sources[file], offset = last ? source.lastIndexOf(text) : source.indexOf(text); assert(offset >= 0);
    const before = source.slice(0, offset).split('\n'); return { line: before.length - 1, character: before.at(-1).length };
  };
  const definitions = (file, text, last = false) => index.definitions('file://' + file, at(file, text, last));
  return { facts, index, at, definitions };
}

test('preprocessor definitions survive malformed C and recover OAI-style macros after attributes', () => {
  const f = fixture({ '/p/a.c': 'int broken( {\n#define GCC_NOTUSED __attribute__((unused))\n#define LOG_USEDINLOG_VAR(A,B) GCC_NOTUSED A B\n#define VCD_SIGNAL_DUMPER_CLOSE()\n' });
  for (const name of ['GCC_NOTUSED', 'LOG_USEDINLOG_VAR', 'VCD_SIGNAL_DUMPER_CLOSE']) assert(f.facts[0].symbols.some(node => node.name === name && node.category === 'macro'));
  assert.equal(f.definitions('/p/a.c', 'GCC_NOTUSED', true)[0].selectionRange.start.line, 1);
});

test('a single long macro line observes the resource budget before finishing extraction', () => {
  let checks = 0;
  assert.throws(() => preprocessorFacts('#define LARGE ' + 'word '.repeat(10000), 'file:///p/a.h', false, () => {
    if (++checks > 1) throw new Error('resource-budget-stop');
  }), /resource-budget-stop/);
});

test('ASN.1 macro recovery does not publish replacement statements as fake global functions', () => {
  const f = fixture({ '/p/asn.h': '#define ASN__E_CALLBACK(size, foo) \\\n do { \\\n  if(foo) goto cb_failed; \\\n  er.encoded += (size); \\\n } while(0)\n' });
  assert(!f.facts[0].symbols.some(node => node.name === 'encoded')); assert.equal(f.facts[0].functions.length, 0); assert.equal(f.facts[0].calls.length, 0);
  assert(f.facts[0].symbols.some(node => node.name === 'ASN__E_CALLBACK'));
});

test('macro bodies, aliases and parameters resolve across continuations with UTF-16 CRLF ranges', () => {
  const source = '/* 中文😀 */\r\n#define BASE 14\r\n#define SIZE BASE\r\n#define COUNT(x, args...) (BASE + \\\r\n (x) + args)\r\nint x = SIZE;\r\n';
  const f = fixture({ '/p/a.c': source });
  assert.equal(f.definitions('/p/a.c', 'BASE', true)[0].name, 'BASE');
  assert.equal(f.definitions('/p/a.c', '(x)', true).length, 0);
  const pos = f.at('/p/a.c', 'x)', true); assert.equal(f.index.definitions(f.facts[0].uri, pos)[0].category, 'macroParameter');
  assert.equal(f.definitions('/p/a.c', 'args', true)[0].selectionRange.start.line, 3);
  const tokens = f.facts[0].identifierData;
  for (let at = WIDTH; at < tokens.length; at += WIDTH) assert(tokens[at + 1] > tokens[at - WIDTH + 1] || tokens[at + 1] === tokens[at - WIDTH + 1] && tokens[at + 2] > tokens[at - WIDTH + 2]);
});

test('macro bodies can navigate typedef names and variadic parameters without creating call edges', () => {
  const f = fixture({ '/p/a.c': 'typedef int Count;\n#define TYPE Count\n#define WRAP(...) work(__VA_ARGS__)\nint work(int x){return x;}' });
  assert.equal(f.definitions('/p/a.c', 'Count', true)[0].name, 'Count');
  assert.equal(f.definitions('/p/a.c', '__VA_ARGS__')[0].name, '__VA_ARGS__');
  assert.equal(f.definitions('/p/a.c', 'work', false)[0].name, 'work'); assert.equal(f.facts[0].calls.length, 0);
});

test('comments, continued line comments and C++ raw strings never become macro definitions', () => {
  const source = '// comment \\\n#define COMMENTED 1\n/* #define BLOCKED 1 */\nconst char *text = R"tag(embedded "\n#define FAKE 1\n)tag";\n#define REAL 3\n';
  const f = fixture({ '/p/a.cpp': source });
  assert.deepEqual(f.facts[0].macros, ['REAL']);
});

test('C++ macros and macro parameters work offline while class binding remains semantic', () => {
  const f = fixture({ '/p/a.cpp': '#define BASE 14\n#define COUNT(x) (x + BASE)\nnamespace N { class Box { int value; }; }\nint a=COUNT(BASE);' });
  assert.equal(f.definitions('/p/a.cpp', 'BASE', true)[0].category, 'macro');
  assert.equal(f.definitions('/p/a.cpp', 'x +')[0].category, 'macroParameter');
  assert.equal(f.definitions('/p/a.cpp', 'Box').length, 0);
  assert(f.index.workspaceSymbols('BASE').length);
});

test('C-only preprocessor extraction excludes known C++ branches and retains unknown alternatives', () => {
  const f = fixture({ '/p/a.h': '#ifdef __cplusplus\n#define CPP_ONLY 1\n#else\n#define C_ONLY 1\n#endif\n#if FEATURE\n#define BOTH 1\n#else\n#define BOTH 2\n#endif\nint value=BOTH;' });
  assert(!f.facts[0].macros.includes('CPP_ONLY')); assert(f.facts[0].macros.includes('C_ONLY'));
  assert.equal(f.definitions('/p/a.h', 'BOTH', true).length, 2);
});

test('unconditional undef and definition order prevent stale macro targets', () => {
  const f = fixture({ '/p/a.c': 'int before=LIMIT;\n#define LIMIT 1\nint good=LIMIT;\n#undef LIMIT\nint gone=LIMIT;\n#define LIMIT 2\nint again=LIMIT;' });
  assert.equal(f.definitions('/p/a.c', 'LIMIT').length, 0);
  assert.equal(f.index.definitions(f.facts[0].uri, { line: 2, character: 9 })[0].selectionRange.start.line, 1);
  assert.equal(f.index.definitions(f.facts[0].uri, { line: 4, character: 9 }).length, 0);
  assert.equal(f.definitions('/p/a.c', 'LIMIT', true)[0].selectionRange.start.line, 5);
});

test('undef restores confirmed calls to a real function and later macros do not hide earlier calls', () => {
  const f = fixture({ '/p/a.c': 'int target(void){return 1;}\nint before(void){return target();}\n#define target() 0\n#undef target\nint after(void){return target();}' });
  for (const name of ['before', 'after']) {
    const fn = [...f.index.functions.values()].find(value => value.name === name), outgoing = f.index.calls(f.index.item(fn), 'outgoing');
    assert.equal(outgoing[0].to.name, 'target'); assert(!outgoing[0].to.sourceInsightReaderLocal.unresolved);
  }
});

test('a header included after the query cannot supply an earlier macro binding', () => {
  const f = fixture({ '/p/api.h': '#define LIMIT 1', '/p/a.c': 'int before=LIMIT;\n#include "api.h"\nint after=LIMIT;' });
  assert.equal(f.definitions('/p/a.c', 'LIMIT').length, 0); assert.equal(f.definitions('/p/a.c', 'LIMIT', true)[0].uri, 'file:///p/api.h');
});

test('SDK directories inside the project provide macros, explicit types and calls without leaking unrelated roots', () => {
  const f = fixture({ '/p/sdk/xran.h': '#define XRAN_NUM_OF_SYMBOL_PER_SLOT 14\nstruct Frame { int value; };\nstatic inline int api(void){return 1;}', '/other/not.h': 'int unrelated;\n#define NOT_VISIBLE 5', '/p/a.c': '#include "xran.h"\nint run(struct Frame *f){return XRAN_NUM_OF_SYMBOL_PER_SLOT + f->value + api();}\nint no=NOT_VISIBLE + unrelated;' });
  assert.equal(f.definitions('/p/a.c', 'XRAN_NUM_OF_SYMBOL_PER_SLOT')[0].uri, 'file:///p/sdk/xran.h');
  assert.equal(f.definitions('/p/a.c', 'value')[0].uri, 'file:///p/sdk/xran.h');
  const fn = [...f.index.functions.values()].find(node => node.name === 'run'); assert.equal(f.index.calls(f.index.item(fn), 'outgoing')[0].to.uri, 'file:///p/sdk/xran.h');
  assert.equal(f.definitions('/p/a.c', 'unrelated').length, 0); assert.equal(f.definitions('/p/a.c', 'NOT_VISIBLE').length, 0);
  const refs = [...f.index.referenceSites('file:///p/sdk/xran.h', { line: 0, character: 8 })].filter(Boolean); assert(refs.some(value => value.uri === 'file:///p/a.c'));
});

test('an SDK directory in the project can supply its unique non-static implementation', () => {
  const f = fixture({ '/p/sdk/api.h': 'int external(void);', '/p/sdk/api.c': 'int external(void){return 1;}', '/p/a.c': '#include "api.h"\nint run(void){return external();}', '/other/a.c': 'int hidden(void){return 2;}' });
  assert.equal(f.definitions('/p/a.c', 'external')[0].uri, 'file:///p/sdk/api.c');
  const fn = [...f.index.functions.values()].find(node => node.name === 'run'); assert.equal(f.index.calls(f.index.item(fn), 'outgoing')[0].to.uri, 'file:///p/sdk/api.c');
});

test('non-self-contained headers inherit only the preceding includes and declarations of their includers', () => {
  const f = fixture({ '/p/sdk/xran.h': '#define XRAN_NUM_OF_SYMBOL_PER_SLOT 14', '/p/oran.h': 'int slots[XRAN_NUM_OF_SYMBOL_PER_SLOT];\nint size=EARLY;\nint bad=LATE;', '/p/a.c': '#include "xran.h"\n#define EARLY 2\n#include "oran.h"\n#define LATE 3' });
  assert.equal(f.definitions('/p/oran.h', 'XRAN_NUM_OF_SYMBOL_PER_SLOT')[0].uri, 'file:///p/sdk/xran.h');
  assert.equal(f.definitions('/p/oran.h', 'EARLY')[0].uri, 'file:///p/a.c'); assert.equal(f.definitions('/p/oran.h', 'LATE').length, 0);
});

test('different includer contexts yield candidates instead of selecting one build', () => {
  const f = fixture({ '/p/shared.h': 'int array[SIZE];', '/p/a.c': '#define SIZE 1\n#include "shared.h"', '/p/b.c': '#define SIZE 2\n#include "shared.h"' });
  assert.equal(f.definitions('/p/shared.h', 'SIZE').length, 2);
});

test('a truncated header context cannot become a falsely unique definition', () => {
  const sources = { '/p/shared.h': 'int array[SIZE];' };
  for (let i = 0; i < 140; i++) sources[`/p/${i}.c`] = `${i === 0 || i === 139 ? '#define SIZE '+i+'\n' : ''}#include "shared.h"`;
  const f = fixture(sources); assert.equal(f.definitions('/p/shared.h', 'SIZE').length, 0);
  assert.equal(f.index.headerContext('file:///p/shared.h').complete, false);
});

test('ambiguous SDK versions remain unresolved and missing dependencies have an actionable explanation', () => {
  const f = fixture({ '/sdk1/xran.h': '#define XRAN 1', '/sdk2/xran.h': '#define XRAN 2', '/p/a.c': '#include "xran.h"\nint n=XRAN;' });
  assert.equal(f.definitions('/p/a.c', 'XRAN').length, 0);
  const result = f.index.explain('file:///p/a.c', f.at('/p/a.c', 'XRAN'));
  assert.equal(result.reason, 'unresolvedInclude'); assert.match(result.note, /xran.h/); assert.match(result.note, /SDK/);
});

test('explicit cast and designated initializer fields bind to their declared record, including nested fields', () => {
  const source = 'struct Inner { int value; };\nstruct Outer { struct Inner child; };\nstruct Wrong { int value; };\n' +
    'void run(void *p){ ((struct Inner *)p)->value; struct Outer out={.child.value=1}; struct Outer x={.child={.value=2}}; ( (struct Inner){.value=3} ).value; }';
  const f = fixture({ '/p/a.c': source });
  const line = source.split('\n')[3];
  for (const match of line.matchAll(/value/g)) assert.equal(f.index.definitions(f.facts[0].uri, { line: 3, character: match.index })[0].selectionRange.start.line, 0);
});

test('SQLite preserves recovered macros, SDK visibility and explicit field types across reopening', async t => {
  const f = fixture({ '/p/sdk/api.h': '#define LIMIT 14\nstruct Node { int value; };\nint external(void);', '/p/sdk/api.c': 'int external(void){return 1;}', '/p/indirect.h': 'int slots[LIMIT];', '/p/a.c': '#include "api.h"\n#include "indirect.h"\n#define SIZE LIMIT\nint run(void *p){return ((struct Node*)p)->value+SIZE+external();}' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-release-audit-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const descriptors = f.facts.map(file => ({ uri: file.uri, path: file.path, project: file.project }));
  let repository = new SqliteIndexRepository(directory, 'test'); await repository.open(null, false, { descriptors }); for (const file of f.facts) repository.stage(file);
  const first = new CIndex(repository); first.replace([...repository.files.values()]); repository.close();
  repository = new SqliteIndexRepository(directory, 'test'); t.after(() => repository.close()); await repository.open(null, false, { descriptors });
  const index = new CIndex(repository); index.replace([...repository.files.values()]);
  assert.equal(index.definitions('file:///p/a.c', f.at('/p/a.c', 'LIMIT'))[0].uri, 'file:///p/sdk/api.h');
  assert.equal(index.definitions('file:///p/a.c', f.at('/p/a.c', 'value'))[0].uri, 'file:///p/sdk/api.h');
  assert.equal(index.definitions('file:///p/indirect.h', f.at('/p/indirect.h', 'LIMIT'))[0].uri, 'file:///p/sdk/api.h');
  const external = [...index.functions.values()].find(node => node.name === 'external');
  assert.equal(index.calls(index.item(external), 'incoming')[0].from.uri, 'file:///p/a.c');
});

test('a same-content timestamp update changes only thin metadata and preserves queryable disk facts', async t => {
  const f = fixture({ '/p/a.c': 'int kept(void){return 1;}' }), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-thin-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); const repository = new SqliteIndexRepository(directory, 'test'); t.after(() => repository.close());
  await repository.open(null, false, { descriptors: f.facts }); repository.stage({ ...f.facts[0], stamp: { size: 24, mtime: 1 } });
  const view = repository.bind(repository.get(f.facts[0].uri), f.facts[0], { size: 24, mtime: 2 }); repository.stage(view);
  assert.equal(repository.get(f.facts[0].uri).symbols[0].name, 'kept'); assert.equal(repository.forUri(f.facts[0].uri).fileMetadata(f.facts[0].uri).stamp.mtime, 2);
});
