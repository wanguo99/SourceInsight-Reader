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
  const report = { corpusVersion: 1, cases: [], known: 0, correct: 0, unknown: 0, falseTargets: 0 };
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
