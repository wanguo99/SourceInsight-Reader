'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { symbolScore, rankSymbols } = require('../src/domain/symbol-search');
const { referenceSnippet } = require('../src/features/result-snippet');
test('identifier search supports unordered distinct fragments, snake case and camel abbreviations', () => {
  for (const query of ['str copy', 'copy str', 'StrCop', 'string_copy']) assert(symbolScore('bmc_string_copy_nullable', query) >= 0, query);
  assert(symbolScore('CreateWindowEx', 'CreWin') >= 0);
  assert(symbolScore('HTTPServerRequest', 'req http') >= 0);
  assert.equal(symbolScore('CreateWindow', 'c z'), -1);
  assert.equal(symbolScore('StringCopy', 'str str'), -1);
  assert(symbolScore('CopyCommand', 'c copy') >= 0);
  const sorted = rankSymbols(['copy', 'bmc_copy', 'copy_string'].map(name => ({ name })), 'copy');
  assert.deepEqual(sorted.map(value => value.name), ['copy', 'copy_string', 'bmc_copy']);
});
test('long identifier searches remain bounded and long lines keep the actual reference visible', () => {
  assert.equal(symbolScore(Array(100).fill('part').join('_'), 'ppppppppppppppppppppZ'), -1);
  const text = 'x'.repeat(1000) + 'target();' + 'y'.repeat(1000);
  const snippet = referenceSnippet(text, { start: { line: 2, character: 1000 }, end: { line: 2, character: 1006 } });
  assert.equal(snippet.matched, 'target'); assert(snippet.before.startsWith('…')); assert(snippet.after.endsWith('…'));
  assert(snippet.before.length + snippet.matched.length + snippet.after.length <= 502);
});

test('global search combines local and semantic results, removes duplicates and tolerates provider failure', async () => {
  const { fakeVscode, loadWithVscode } = require('./fake-vscode');
  const env = fakeVscode(); const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const doc = env.document('symbols.c');
  const item = { name: 'string_copy', kind: 11, location: { uri: doc.uri, range: new env.api.Range(0, 4, 0, 15) } };
  const adapter = new LanguageAdapter({ enabled: () => true, workspaceSymbols: async () => [item] });
  env.commands.set('vscode.executeWorkspaceSymbolProvider', async () => [item]);
  assert.equal((await adapter.workspaceSymbols('str copy')).length, 1);
  env.commands.set('vscode.executeWorkspaceSymbolProvider', async () => { throw new Error('no server'); });
  assert.equal((await adapter.workspaceSymbols('copy str'))[0].name, item.name);
});
