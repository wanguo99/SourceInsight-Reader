'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeVscode, loadWithVscode } = require('./fake-vscode');

test('native C definition links use the local index without recursive semantic requests and respect cancellation', async () => {
  const env = fakeVscode(); let provider, selector, calls = 0;
  env.api.languages.registerDefinitionProvider = (value, implementation) => {
    selector = value; provider = implementation; return new env.api.Disposable();
  };
  const doc = env.document('links.c', 'void main() { target(); }\nvoid target() {}');
  const range = new env.api.Range(1, 5, 1, 11), token = { isCancellationRequested: false };
  const index = { enabled: () => true, supports: () => true, log() {},
    definitions: async () => { calls++; return [{ uri: doc.uri, range }]; } };
  const { registerLocalDefinitions } = loadWithVscode('../src/definition-provider', env.api);
  const registration = registerLocalDefinitions(index);
  assert.equal(selector[0].language, 'c'); assert.equal(selector[0].scheme, 'file');
  assert(selector.some(value => value.language === 'cpp' && value.scheme === 'file'));
  let result = await provider.provideDefinition(doc, new env.api.Position(0, 15), token);
  assert.equal(result[0].targetUri, doc.uri); assert.equal(result[0].targetSelectionRange, range);
  assert.equal(result[0].originSelectionRange.start.line, 0); assert.equal(calls, 1);
  token.isCancellationRequested = true;
  assert.equal((await provider.provideDefinition(doc, new env.api.Position(0, 15), token)).length, 0);
  assert.equal(calls, 1);
  token.isCancellationRequested = false;
  index.definitions = async () => { token.isCancellationRequested = true; return [{ uri: doc.uri, range }]; };
  assert.equal((await provider.provideDefinition(doc, new env.api.Position(0, 15), token)).length, 0);
  registration.dispose();
});
