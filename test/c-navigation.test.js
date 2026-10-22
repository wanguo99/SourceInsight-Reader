'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');

async function project(sources) {
  const parser = await createParser(), index = new CIndex();
  try { index.replace(Object.entries(sources).map(([name, text]) => ({
    ...parseC(parser, text, `file:///project/${name}`, `/project/${name}`), project: 'project'
  }))); } finally { parser.delete(); }
  const query = (file, line, name, last = false) => {
    const text = sources[file].split('\n')[line];
    const positions = [...text.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].map(match => match.index);
    const character = last ? positions.at(-1) : positions[0];
    assert(character >= 0, `${file}:${line}: ${name}`);
    return index.definitions(`file:///project/${file}`, { line, character });
  };
  return { index, query };
}

test('C navigation distinguishes tag names, typedef names and values with the same spelling', async () => {
  const { query } = await project({ 'main.c': 'struct Same { int value; };\nint Same;\n' +
    'void run(void) {\nint Same = 1;\nstruct Same item;\nSame++;\n}\n' +
    'union Other { int value; };\nint Other;\nunion Other other;\n' });
  assert.equal(query('main.c', 4, 'Same')[0].selectionRange.start.line, 0);
  assert.equal(query('main.c', 5, 'Same')[0].selectionRange.start.line, 3);
  assert.equal(query('main.c', 9, 'Other')[0].selectionRange.start.line, 7);
});

test('C navigation indexes anonymous enumerators and conditional aggregate members', async () => {
  const { index, query } = await project({ 'main.c': 'enum { ANON = 3 };\n' +
    'enum Mode {\n#if FLAG\nON,\n#else\nOFF,\n#endif\n};\n' +
    'struct Record {\n#if FLAG\nint first;\n#else\nint second;\n#endif\n};\n' +
    'int run(void) { return ANON + ON + OFF; }\n' });
  for (const [name, line] of [['ANON', 0], ['ON', 3], ['OFF', 5]]) {
    assert.equal(query('main.c', 15, name)[0].selectionRange.start.line, line);
    assert(index.workspaceSymbols(name).some(symbol => symbol.name === name));
  }
  for (const name of ['first', 'second']) assert(index.workspaceSymbols(name).some(symbol => symbol.name === name));
});

test('C navigation scopes local typedefs, records and enumerators to their blocks', async () => {
  const { query, index } = await project({ 'main.c': 'void run(void) {\n' +
    'typedef int Local;\nstruct Record { int x; };\nenum Mode { LOCAL };\nenum { ANON };\n' +
    'Local n = LOCAL + ANON;\nstruct Record item;\nenum Mode mode;\n' +
    '{ typedef char Local; Local inner; }\nLocal outer;\n}\nvoid other(void) { Local missing; LOCAL; ANON; struct Record *missingRecord; }\n' });
  for (const [line, name, target] of [[5, 'Local', 1], [5, 'LOCAL', 3], [5, 'ANON', 4],
    [6, 'Record', 2], [7, 'Mode', 3], [8, 'Local', 8], [9, 'Local', 1]]) {
    const definitions = query('main.c', line, name, line === 8);
    assert.equal(definitions.length, 1, `${name} at ${line}`);
    assert.equal(definitions[0].selectionRange.start.line, target);
  }
  for (const name of ['Local', 'LOCAL', 'ANON', 'Record']) assert.equal(query('main.c', 11, name).length, 0, name);
  assert.equal(index.workspaceSymbols('LOCAL').some(symbol => symbol.name === 'LOCAL'), false);
});

test('C navigation resolves parameter declaration names and nested variable shadowing', async () => {
  const { query } = await project({ 'main.c': 'int arg;\nvoid run(int arg) {\narg++;\n{ int arg; arg++; }\narg++;\n}\n' });
  for (const line of [1, 2, 4]) assert.equal(query('main.c', line, 'arg')[0].selectionRange.start.line, 1);
  assert.equal(query('main.c', 3, 'arg', true)[0].selectionRange.start.line, 3);
});

test('C navigation resolves function references, declarations and function macros', async () => {
  const { query } = await project({
    'api.h': '#define WRAP(x) (x)\n#define LIMIT 4\nint leaf(void);\nint declaration_only(void);\n',
    'impl.c': '#include "api.h"\nint leaf(void) { return 0; }\n',
    'main.c': '#include "api.h"\nvoid run(void) { register_cb(leaf); int n = WRAP(LIMIT); declaration_only(); }\n'
  });
  assert(query('main.c', 1, 'leaf')[0].uri.endsWith('/impl.c'));
  assert(query('api.h', 2, 'leaf')[0].uri.endsWith('/impl.c'));
  assert.equal(query('main.c', 1, 'WRAP')[0].selectionRange.start.line, 0);
  assert.equal(query('api.h', 0, 'WRAP')[0].selectionRange.start.line, 0);
  assert.equal(query('main.c', 1, 'LIMIT')[0].selectionRange.start.line, 1);
  assert.equal(query('main.c', 1, 'declaration_only')[0].selectionRange.start.line, 3);
});

test('C navigation prefers variable definitions over externs and rejects foreign static variables and macros', async () => {
  const { query } = await project({
    'api.h': 'extern int total;\nstatic int header_value;\n',
    'impl.c': 'int total = 2;\nstatic int secret;\n#define PRIVATE 1\n',
    'main.c': '#include "api.h"\nint run(void) { return total + secret + PRIVATE + header_value; }\n'
  });
  assert(query('main.c', 1, 'total')[0].uri.endsWith('/impl.c'));
  assert.equal(query('main.c', 1, 'secret').length, 0);
  assert.equal(query('main.c', 1, 'PRIVATE').length, 0);
  assert.equal(query('main.c', 1, 'header_value')[0].selectionRange.start.line, 1);
});

test('C navigation uses the receiver type for fields and never guesses an unknown receiver', async () => {
  const { query } = await project({ 'main.c': 'int value;\nstruct A { int value; };\nstruct B { int value; };\n' +
    'int run(struct A *a) { return a->value; }\nint unknown(void *a) { return a->value; }\n' });
  assert.equal(query('main.c', 3, 'value')[0].selectionRange.start.line, 1);
  assert.equal(query('main.c', 4, 'value').length, 0);
  assert.equal(query('main.c', 3, 'A')[0].selectionRange.start.line, 1);
});

test('C navigation follows fields one declaration at a time through pointers, aliases and arrays', async () => {
  const { query } = await project({
    'api.h': 'struct bmc_point_sample { int value; };\n' +
      'struct bmc_collect_result {\nstruct bmc_point_sample *samples;\n};\n' +
      'typedef struct bmc_collect_result Result;\ntypedef Result ResultAlias;\n',
    'main.c': '#include "api.h"\nvoid read(ResultAlias *bmc_result) {\n' +
      'bmc_result->samples;\nbmc_result->samples[0].value;\n(*bmc_result).samples;\n}\n'
  });
  for (const line of [2, 3, 4]) {
    const field = query('main.c', line, 'samples');
    assert.equal(field.length, 1);
    assert(field[0].uri.endsWith('/api.h'));
    assert.equal(field[0].selectionRange.start.line, 2);
  }
  assert.equal(query('main.c', 3, 'value')[0].selectionRange.start.line, 0);
  assert.equal(query('api.h', 2, 'bmc_point_sample')[0].selectionRange.start.line, 0);
  assert.equal(query('api.h', 2, 'samples')[0].selectionRange.start.line, 2);
  assert.equal(query('main.c', 2, 'bmc_result')[0].selectionRange.start.line, 1);
});

test('C field navigation follows block-local typedefs and inline anonymous records', async () => {
  const { query } = await project({ 'main.c': 'struct A { int first; };\nstruct B { int second; };\n' +
    'void run(void) {\ntypedef struct A Alias;\nAlias a;\na.first;\n' +
    '{ typedef struct B Alias; Alias b; b.second; a.first; }\n' +
    'struct { int member; } record;\nrecord.member;\n}\n' });
  assert.equal(query('main.c', 5, 'first')[0].selectionRange.start.line, 0);
  assert.equal(query('main.c', 6, 'second')[0].selectionRange.start.line, 1);
  assert.equal(query('main.c', 6, 'first')[0].selectionRange.start.line, 0);
  assert.equal(query('main.c', 8, 'member')[0].selectionRange.start.line, 7);
});

test('C field navigation handles promoted anonymous members and nested records without guessing casts', async () => {
  const { query, index } = await project({ 'main.c': 'struct Outer {\nunion { int promoted; };\n' +
    'struct { int nested; } inner;\n};\n' +
    'void run(struct Outer *outer, void *unknown) {\nouter->promoted;\nouter->inner.nested;\nunknown->promoted;\n}\n' +
    'typedef enum { UNIQUE } Alias;\n' });
  assert.equal(query('main.c', 5, 'promoted')[0].selectionRange.start.line, 1);
  assert.equal(query('main.c', 6, 'nested')[0].selectionRange.start.line, 2);
  assert.equal(query('main.c', 7, 'promoted').length, 0);
  assert.equal(index.workspaceSymbols('UNIQUE').filter(symbol => symbol.name === 'UNIQUE').length, 1);
});
