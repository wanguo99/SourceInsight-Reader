'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

for (const [language, filename] of [['java', 'Main.java'], ['python', 'main.py']]) {
  test(`${language} uses semantic symbols, definitions, references and both call directions without a C index`, async () => {
    const env = fakeVscode();
    const doc = env.document(filename, language === 'java' ? 'class Main {}' : 'def leaf(): pass');
    doc.languageId = language;
    const range = new env.api.Range(0, 0, 0, 4);
    const location = { uri: doc.uri, range };
    const item = { name: 'leaf', kind: 11, uri: doc.uri, range, selectionRange: range };
    const caller = { ...item, name: 'process' };
    const commands = [];
    const register = (name, result) => env.commands.set(name, async () => { commands.push(name); return result; });
    register('vscode.executeDocumentSymbolProvider', [{ ...item, children: [] }]);
    register('vscode.executeDefinitionProvider', [location]);
    register('vscode.executeTypeDefinitionProvider', []);
    register('vscode.executeReferenceProvider', [location, location]);
    register('vscode.executeWorkspaceSymbolProvider', [{ name: 'leaf', kind: 11, location }]);
    register('vscode.prepareCallHierarchy', [item]);
    register('vscode.provideIncomingCalls', [{ from: caller, fromRanges: [range] }]);
    register('vscode.provideOutgoingCalls', [{ to: caller, fromRanges: [range] }]);
    const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
    const adapter = new LanguageAdapter();
    assert.equal((await adapter.symbols(doc.uri))[0].name, 'leaf');
    assert.equal((await adapter.definitions(doc.uri, range.start))[0].uri.toString(), doc.uri.toString());
    assert.equal((await adapter.contextDefinitions(doc.uri, range.start)).mode, '定义');
    assert.equal((await adapter.references(doc.uri, range.start)).length, 1);
    assert.equal((await adapter.workspaceSymbols('leaf'))[0].name, 'leaf');
    const { LanguageServiceProvider, LocalCProvider } = loadWithVscode('../src/providers/relation-providers', env.api);
    const { RelationBackend } = require('../src/relation-backend');
    const backend = new RelationBackend({
      local: new LocalCProvider(), semantic: new LanguageServiceProvider(),
      settings: (key, fallback) => fallback, scope: () => language
    });
    const roots = await backend.prepare({ uri: doc.uri.toString(), range });
    assert.equal(roots.provider, 'languageService');
    for (const direction of ['incoming', 'outgoing']) {
      const result = await backend.calls(roots.data[0], direction);
      assert.equal(result.status, 'ready');
      assert.equal(result.data[0].symbol.name, 'process');
      assert.equal(result.data[0].sites.length, 1);
    }
    assert(commands.includes('vscode.provideIncomingCalls'));
    assert(commands.includes('vscode.provideOutgoingCalls'));
    backend.dispose();
  });
}

test('semantic workspace search waits beyond the former 800ms limit and respects configured timeouts', async () => {
  const env = fakeVscode();
  const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
  const doc = env.document('Main.java');
  const item = { name: 'leaf', kind: 11, location: { uri: doc.uri, range: new env.api.Range(0, 0, 0, 4) } };
  env.commands.set('vscode.executeWorkspaceSymbolProvider', () => new Promise(resolve => setTimeout(() => resolve([item]), 850)));
  assert.equal((await new LanguageAdapter().workspaceSymbols('leaf')).length, 1);
  env.settings.set('sourceInsightReader.workspaceSymbolTimeoutMs', 100);
  env.commands.set('vscode.executeWorkspaceSymbolProvider', () => new Promise(() => {}));
  assert.deepEqual(await new LanguageAdapter().workspaceSymbols('leaf'), []);
});
