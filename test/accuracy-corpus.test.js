'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createParser, parseC } = require('../src/c-parser');
const { CIndex } = require('../src/c-index');
const cases = require('./fixtures/accuracy/cases.json');
function point(source, query) {
  let at = -1;
  for (let i = 0; i <= (query.occurrence || 0); i++) at = source.indexOf(query.needle, at + 1);
  assert(at >= 0, query.needle); at += query.offset || 0;
  const before = source.slice(0, at).split('\n'); return { line: before.length - 1, character: before.at(-1).length };
}

test('annotated C accuracy corpus separates confirmed targets from unknown bindings', async t => {
  const parser = await createParser(); t.after(() => parser.delete());
  const report = { corpusVersion: 2, cases: [], known: 0, correct: 0, unknown: 0, falseTargets: 0 };
  for (const sample of cases) await t.test(sample.id, () => {
    const index = new CIndex();
    index.replace(Object.entries(sample.sources).map(([name, source]) => ({ ...parseC(parser, source, 'file:///accuracy/' + name, '/accuracy/' + name), project: 'corpus' })));
    const values = index.definitions('file:///accuracy/' + sample.query.file, point(sample.sources[sample.query.file], sample.query));
    // Multiple candidates are unknown; the UI must require a choice.
    const actual = values.length === 1 ? { file: values[0].uri.replace('file:///accuracy/', ''), ...values[0].selectionRange.start } : undefined;
    const expected = sample.expected[0] ? { file: sample.expected[0].file, ...point(sample.sources[sample.expected[0].file], sample.expected[0]) } : undefined;
    if (sample.classification === 'known') { report.known++; if (JSON.stringify(actual) === JSON.stringify(expected)) report.correct++; else report.falseTargets++; }
    else { report.unknown++; if (actual) report.falseTargets++; }
    report.cases.push({ id: sample.id, classification: sample.classification, candidates: values.length, actual, expected });
    assert.deepEqual(actual, expected);
  });
  if (process.env.SOURCEINSIGHT_READER_ACCURACY_REPORT) {
    fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/accuracy-results.json', JSON.stringify(report, null, 2) + '\n');
  }
  assert.equal(report.falseTargets, 0);
});

test('annotated C accuracy corpus preserves confirmed targets after SQLite reopen', async t => {
  const os = require('node:os'), path = require('node:path');
  const { SqliteIndexRepository } = require('../src/infrastructure/sqlite-index-repository');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-accuracy-sqlite-'));
  const parser = await createParser();
  t.after(() => { parser.delete(); fs.rmSync(directory, {recursive:true,force:true}); });
  const report = {corpusVersion:2, backend:'sqlite-reopened', cases:[], known:0, correct:0, unknown:0, falseTargets:0};
  for (const sample of cases) await t.test(sample.id, async () => {
    const repository = new SqliteIndexRepository(path.join(directory,sample.id),'accuracy');
    try {
      const facts = Object.entries(sample.sources).map(([name,source])=>({...parseC(parser,source,'file:///accuracy/'+name,'/accuracy/'+name),project:'corpus'}));
      const descriptors = facts.map(({uri,path,project})=>({uri,path,project}));
      await repository.open(undefined,false,{descriptors}); for (const file of facts) repository.stage(file);
      await repository.open(undefined,false,{descriptors});
      const index = new CIndex(repository); index.replace([...repository.files.values()]);
      const values = index.definitions('file:///accuracy/'+sample.query.file,point(sample.sources[sample.query.file],sample.query));
      const actual = values.length===1 ? {file:values[0].uri.replace('file:///accuracy/',''),...values[0].selectionRange.start} : undefined;
      const expected = sample.expected[0] ? {file:sample.expected[0].file,...point(sample.sources[sample.expected[0].file],sample.expected[0])} : undefined;
      if (sample.classification==='known') {report.known++; if (JSON.stringify(actual)===JSON.stringify(expected)) report.correct++; else report.falseTargets++;}
      else {report.unknown++; if (actual) report.falseTargets++;}
      report.cases.push({id:sample.id,classification:sample.classification,candidates:values.length,actual,expected});
      assert.deepEqual(actual,expected);
    } finally {repository.close();}
  });
  if (process.env.SOURCEINSIGHT_READER_ACCURACY_REPORT) fs.writeFileSync('dist/accuracy-sqlite-results.json',JSON.stringify(report,null,2)+'\n');
  assert.equal(report.falseTargets,0);
});
