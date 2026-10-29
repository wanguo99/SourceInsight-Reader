'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('an invalid optional cache directory does not hide usable local symbols', async t => {
  const env = fakeVscode(), doc = env.document('symbols.c', 'int target(void) { return 1; }');
  doc.languageId = 'c';
  env.settings.set('sourceInsightReader.cacheDirectory', 'relative/cache');
  const root = { uri: env.api.Uri.file('/project') }, log = [];
  const catalog = { accepts: () => true, document: () => doc, folder: () => root };
  const { UnifiedIndexClient } = loadWithVscode('../src/infrastructure/unified-index-client', env.api);
  const store = new UnifiedIndexClient(env.context, catalog, message => log.push(message));
  t.after(() => store.dispose());
  const range = new env.api.Range(0, 0, 0, 35);
  const symbol = { name: 'target', kind: 11, range, selectionRange: range, children: [] };
  const local = { enabled: () => true, supports: () => true, symbols: async () => [symbol], log: () => {} };
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const adapter = new LanguageAdapter(local, catalog, store);
  t.after(() => adapter.dispose());
  const result = await adapter.symbols(doc.uri);
  assert(result.some(item => item.name === 'target'));
  assert.equal(log.length, 1);
  assert.match(log[0], /缓存不可用/);
  assert.equal(store.worker, undefined);
});

test('invalid cache settings can recover without reloading the extension or logging every query', () => {
  const env = fakeVscode(), doc = env.document('symbols.c'), log = [];
  const catalog = { accepts: () => true, document: () => doc, folder: () => ({ uri: env.api.Uri.file('/project') }) };
  const { UnifiedIndexClient } = loadWithVscode('../src/infrastructure/unified-index-client', env.api);
  const store = new UnifiedIndexClient(env.context, catalog, message => log.push(message));
  try {
    env.settings.set('sourceInsightReader.cacheDirectory', 'relative/cache');
    assert.equal(store.descriptor(doc.uri, 'symbols'), undefined);
    assert.equal(store.descriptor(doc.uri, 'symbols'), undefined);
    assert.equal(log.length, 1);
    env.settings.set('sourceInsightReader.cacheDirectory', '/valid-cache');
    assert.equal(store.descriptor(doc.uri, 'symbols').directory, '/valid-cache');
    env.settings.set('sourceInsightReader.cacheDirectory', 'relative/cache');
    assert.equal(store.descriptor(doc.uri, 'symbols'), undefined);
    assert.equal(log.length, 2);
  } finally { store.dispose(); }
});
