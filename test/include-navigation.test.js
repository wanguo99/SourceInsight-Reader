'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');
const { literalIncludes, literalIncludeAt } = require('../src/infrastructure/include-paths');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
let parser;
test.before(async () => { parser = await createParser(); });
test.after(() => parser.delete());
const rangeAt = (env, document, text) => {
  const offset = document.getText().indexOf(text), before = document.getText().slice(0, offset), line = before.split('\n').length - 1;
  assert(offset >= 0); return new env.api.Range(line, offset - before.lastIndexOf('\n') - 1, line, offset - before.lastIndexOf('\n') - 1 + text.length);
};

test('literal include paths retain unknown conditional branches and exact UTF-16 locations', () => {
  const env = fakeVscode(), source = env.document('main.c', '#if CONFIG_NETWORK\r\n/* 😀 */ #include "driver/my-header.v2.h"\r\n#endif\r\n#if CONFIG_CAMERA && CONFIG_WEB\r\n# include <web/server.h>\r\n#endif');
  source.languageId = 'c';
  const includes = literalIncludes(source); assert.deepEqual(includes.map(value => value.name), ['driver/my-header.v2.h', 'web/server.h']);
  for (const include of includes) {
    assert.equal(source.lineAt(include.range.start.line).text.slice(include.range.start.character, include.range.end.character), include.name);
    assert.equal(literalIncludeAt(source, { ...include.range.start, character: include.range.start.character + include.name.indexOf('/') }).name, include.name);
    assert.equal(literalIncludeAt(source, include.range.end), undefined);
  }
});

test('include detection ignores comments, macro replacements and raw strings and refreshes edited documents', () => {
  const env = fakeVscode(), document = env.document('main.cpp', '/*\n#include "comment.h"\n*/\n' +
    'const char *raw=R"tag(\n#include "raw.h"\n)tag";\n#define WRAP \\\n #include "macro.h"\n#include HEADER_MACRO\n#include "real.h"');
  assert.deepEqual(literalIncludes(document).map(value => value.name), ['real.h']);
  const old = rangeAt(env, document, 'real.h').start;
  document.text = document.text.replace('real.h', 'next.h'); document.version++;
  assert.equal(literalIncludeAt(document, old).name, 'next.h');
  document.languageId = 'python'; assert.deepEqual(literalIncludes(document), []);
});

test('continued include directives preserve the literal path origin', () => {
  const env = fakeVscode(), document = env.document('main.c', '# include \\\n /* note */ "component/api.h"\n'); document.languageId = 'c';
  const include = literalIncludeAt(document, { line: 1, character: 18 });
  assert.equal(include.name, 'component/api.h'); assert.equal(include.range.start.line, 1);
  assert.equal(document.lineAt(1).text.slice(include.range.start.character, include.range.end.character), include.name);
});

function fixture(env, sources) {
  const documents = Object.entries(sources).map(([file, text]) => { const document = env.document(file, text); document.languageId = 'c'; return document; });
  const index = new CIndex(); index.replace(documents.map(document => ({ ...parseC(parser, document.getText(), document.uri.toString(), document.uri.fsPath), project: 'file:///project' })));
  return { index, documents };
}

test('physical header navigation offers same-project candidates without speculative dependency edges', () => {
  const env = fakeVscode(), { index, documents } = fixture(env, { 'main.c': '#if CONFIG_A\n#include "service.h"\n#endif',
    'components/one/include/service.h': 'static int api(void){return 1;}', 'components/two/include/service.h': 'static int api(void){return 2;}' });
  const include = literalIncludeAt(documents[0], { line: 1, character: 12 });
  assert.equal(index.includeDefinitions(documents[0].uri.toString(), include).length, 2);
  assert.deepEqual(index.includeRelations(documents[0].uri.toString()), []);
  const foreign = { ...parseC(parser, '', 'file:///sdk/foreign.h', '/sdk/foreign.h'), project: 'file:///sdk' };
  index.replace([...index.files.values(), foreign]);
  assert.deepEqual(index.includeDefinitions(documents[0].uri.toString(), { name: 'foreign.h', quoted: true }), []);
  assert.deepEqual(index.includeDefinitions(documents[0].uri.toString(), { name: '../sdk/foreign.h', quoted: true }), []);
});

test('header selection prefers quoted neighbors and navigates known inactive branches without rebuilding facts', () => {
  const env = fakeVscode(), { index, documents } = fixture(env, { 'src/main.c': '#ifdef __cplusplus\n#include "api.h"\n#endif',
    'src/api.h': '', 'include/api.h': '', 'tools/include/api.h': '' });
  const include = literalIncludes(documents[0])[0], uri = documents[0].uri.toString();
  assert.equal(index.includeDefinitions(uri, include)[0].uri, documents[1].uri.toString());
  assert.equal(index.includeDefinitions(uri, { ...include, quoted: false })[0].uri, documents[2].uri.toString());
});

test('Context opens component headers without an SDK and keeps multiple header candidates explicit', async () => {
  const env = fakeVscode(), modules = new Map(), load = file => loadWithVscode(require.resolve(file), env.api, modules);
  const { index, documents } = fixture(env, { 'runtime.c': '#include "missing_sdk.h"\n#if CONFIG_NETWORK && CONFIG_WEB\n#include "wifi_manager.h"\n#endif\n#include "duplicate.h"',
    'components/network/include/wifi_manager.h': '#pragma once\nint wifi_manager_init(void);', 'one/duplicate.h': '', 'two/duplicate.h': '' });
  const local = { enabled: () => true, supports: () => true, log() {}, definitions: async (uri, point) => {
    const document = env.documents.get(uri.toString()), include = literalIncludeAt(document, point);
    return (include ? index.includeDefinitions(uri.toString(), include) : index.definitions(uri.toString(), point)).map(node => ({ uri: env.api.Uri.parse(node.uri), range: new env.api.Range(0, 0, 0, 0) }));
  }, explain: async () => ({ note: 'Unrelated SDK list must never appear for a header path' }) };
  const language = new (load('../src/language').LanguageAdapter)(local);
  const view = new (load('../src/context').ContextView)(language, () => {});
  try {
    await view.definition({ uri: documents[0].uri, range: rangeAt(env, documents[0], 'wifi_manager.h') });
    assert.equal(view.current.uri.toString(), documents[1].uri.toString()); assert.match(view.state.status, /头文件路径/);
    await view.show({ uri: documents[0].uri, range: new env.api.Range(0, 0, 0, 0) });
    assert(view.state.lines.find(line => line.number === 3).includeRange);
    await view.handleMessage({ action: 'navigate', snapshot: view.snapshot, line: 2, character: 10 });
    assert.equal(view.current.uri.toString(), documents[1].uri.toString());
    await view.definition({ uri: documents[0].uri, range: rangeAt(env, documents[0], 'duplicate.h') });
    assert.equal(view.current, undefined); assert.equal(view.state.candidates.length, 2);
    await view.definition({ uri: documents[0].uri, range: rangeAt(env, documents[0], 'missing_sdk.h') });
    assert.equal(view.current, undefined); assert.match(view.state.status, /missing_sdk\.h/); assert(!view.state.status.includes('Unrelated SDK list'));
  } finally { view.dispose(); language.dispose(); }
});
