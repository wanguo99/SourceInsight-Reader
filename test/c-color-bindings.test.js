'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const { SqliteIndexRepository } = require('../src/infrastructure/sqlite-index-repository');
const { cColorSpans, combinedColorSpans } = require('../src/infrastructure/c-color-spans');
const { boundColorSpan } = require('../src/infrastructure/c-color-bindings');
const { exportReferences } = require('../src/infrastructure/c-export-references');
const { colorTokens } = require('../src/preview-colors');
const header = '#define READY 1\nenum State { IDLE };\ntypedef int counter_t;\ntypedef int (*callback_t)(int);\nstruct ops { union { int (*xfer)(int); int (*master_xfer)(int); }; callback_t master_xfer_atomic; int value; };\nstruct device { struct ops *algo; };\nint leaf(int);\n';
const source = '#include "ops.h"\nstatic int count;\nint __i2c_transfer(struct device *adap, int parameter) {\n counter_t local = IDLE + READY;\n if (adap->algo->master_xfer) local += adap->algo->master_xfer(parameter);\n local += adap->algo->master_xfer_atomic(parameter) + leaf(count);\n return local + UNKNOWN + missing() + adap->missing;\n}\nEXPORT_SYMBOL(__i2c_transfer);\n#define WRAP(arg) (arg + count + UNKNOWN_MACRO_BODY)\n';
for (const persistent of [false, true]) test(`indexed C role matrix survives ${persistent ? 'SQLite reopen' : 'memory'} and semantic conflicts`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-color-matrix-'));
  const project = pathToFileURL(directory).toString(), parser = await createParser();
  const files = [['ops.h', header], ['core.c', source]].map(([name, text]) => {
    const file = path.join(directory, name); return { ...parseC(parser, text, pathToFileURL(file).toString(), file), project };
  });
  const repository = persistent ? new SqliteIndexRepository(path.join(directory, 'cache'), 'colors') : undefined;
  t.after(async () => { parser.delete(); repository?.close(); await fs.rm(directory, {recursive:true,force:true}); });
  if (repository) {
    const descriptors = files.map(({uri, path, project}) => ({uri, path, project}));
    await repository.open(undefined, false, {descriptors}); for (const file of files) repository.stage(file);
    await repository.open(undefined, false, {descriptors});
  }
  const index = new CIndex(repository); index.replace(repository ? [...repository.files.values()] : files);
  const spans = cColorSpans(parser, source), exports = exportReferences(source), lines = source.split('\n');
  const colors = spans.map(span => ({ ...boundColorSpan(index, files[1].uri, span, exports), name: lines[span.line].slice(span.start, span.end) }));
  const named = name => colors.filter(span => span.name === name);
  assert.equal(named('master_xfer').find(span => span.type === 'function')?.indexed, true);
  assert.equal(named('master_xfer').find(span => span.type === 'property')?.indexed, true);
  assert(named('master_xfer_atomic').every(span => span.type === 'function' && span.indexed));
  assert(named('leaf').every(span => span.type === 'function' && span.indexed));
  assert(named('IDLE').every(span => span.type === 'enumMember' && span.indexed));
  assert(named('READY').every(span => span.type === 'macro' && span.indexed));
  assert(named('counter_t').every(span => span.type === 'type' && span.indexed));
  assert(named('parameter').every(span => span.type === 'parameter' && span.indexed));
  assert(named('local').every(span => span.type === 'variable' && span.indexed));
  assert(named('count').every(span => span.type === 'variable' && span.modifiers.includes('static')));
  for (const name of ['UNKNOWN', 'missing', 'UNKNOWN_MACRO_BODY']) assert(named(name).every(span => span.unresolved && !span.indexed), name);
  const exported = named('__i2c_transfer').find(span => span.line === 8); assert(exported);
  assert.equal(exported.type, 'function'); assert.equal(exported.sourceReference, true); assert(!exported.modifiers.includes('declaration'));
  assert(named('arg').every(span => span.type === 'parameter' && span.indexed));
  const bogus = colors.map(span => ({ ...span, type: 'macro', modifiers: ['declaration'], unresolved: false, indexed: false, sourceReference: false }));
  const merged = combinedColorSpans(colors, bogus);
  for (const span of colors) {
    const actual = merged.find(value => value.line === span.line && value.start === span.start);
    assert.equal(actual.type, span.type); assert.equal(actual.unresolved, span.unresolved);
  }
  const rendered = source.split('\n').flatMap((line, number) => colorTokens([{text:line,kind:'plain'}], number, merged, 'c'));
  for (const name of ['UNKNOWN', 'UNKNOWN_MACRO_BODY']) {
    const token = rendered.find(token => token.text === name); assert(token);
    assert.equal(token.foreground, '#000000'); assert.equal(token.bold, false);
  }
});

test('header language labels respect actual C compatibility and macro bodies stay covered', async t => {
  const { fakeVscode, loadWithVscode } = require('./fake-vscode');
  const env = fakeVscode(), document = env.document('ops.h', header);
  env.settings.set('workbench.colorTheme', 'SourceInsight-Reader Source Insight');
  const { LocalCColors } = loadWithVscode('../src/local-c-colors', env.api), colors = new LocalCColors();
  t.after(() => colors.dispose());
  assert.equal(document.languageId, 'cpp'); assert.equal(colors.enabled(document), true);
  assert((await colors.colorize(document)).some(span => span.type === 'property'));
  document.text = 'namespace n { class Object {}; }'; document.version++;
  assert.equal(colors.enabled(document), false);
});

test('color lookup continues partial batches, caches confirmed and unknown roles, and expires on index changes', async t => {
  const { fakeVscode, loadWithVscode } = require('./fake-vscode');
  const env = fakeVscode(), document = env.document('colors.c', 'int a; int b; int c;');
  const { LocalIndex } = loadWithVscode('../src/local-index', env.api);
  const index = new LocalIndex(env.context, {contains:()=>true,folder:()=>({uri:env.api.Uri.file('/project')})});
  index.worker = {}; let calls = 0;
  index.request = async (action, args) => {
    assert.equal(action, 'colorResolutions'); calls++;
    return {spans:[{...args.spans[0],type:'variable',indexed:true,unresolved:false}],processed:1};
  };
  t.after(() => { index.worker = undefined; index.dispose(); });
  const spans = [4,11,18].map(start=>({line:0,start,end:start+1,type:'variable',modifiers:[]}));
  assert.equal((await index.colorResolutions(document,spans)).length,3); assert.equal(calls,3);
  assert.equal((await index.colorResolutions(document,spans)).length,3); assert.equal(calls,3);
  index.revision++;
  assert.equal((await index.colorResolutions(document,spans)).length,3); assert.equal(calls,6);
  document.text = 'int x;'; document.version++;
  index.request = async () => { calls++; return {spans:[],processed:0}; };
  assert.deepEqual(await index.colorResolutions(document,spans),[]);
});
