'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { LspClient } = require('./lsp-client');
const { normalizeSymbols, normalizeLocation, normalizeCalls, uniqueLocations, locationKey } = require('../src/core');

test('real clangd: symbols, definitions, calls, references and cycles', async t => {
  const root = path.resolve(__dirname, '../examples/cpp');
  const lsp = new LspClient(process.env.CLANGD_PATH || 'clangd', ['--background-index=false', '--log=error'], root);
  t.after(() => lsp.close());
  const rootUri = pathToFileURL(root).href;
  const initialize = await lsp.request('initialize', {
    processId: process.pid, rootUri,
    capabilities: {
      textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        definition: { linkSupport: true }, callHierarchy: {} },
      workspace: { workspaceFolders: true }
    }, workspaceFolders: [{ uri: rootUri, name: 'cpp' }]
  });
  assert.ok(initialize.capabilities.callHierarchyProvider);
  const major = Number(/version\s+(\d+)/.exec(initialize.serverInfo?.version || '')?.[1] || 0);
  t.diagnostic(`Server: ${initialize.serverInfo?.version || 'unknown version'}`);
  lsp.notify('initialized', {});
  const documents = new Map();
  for (const name of ['reader.h', 'main.cpp', 'reader.cpp']) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    const uri = pathToFileURL(path.join(root, name)).href;
    documents.set(name, { uri, text });
    lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'cpp', version: 1, text } });
  }
  const reader = documents.get('reader.cpp');
  function position(text, match, offset = 0) {
    const found = text.indexOf(match);
    assert.ok(found >= 0);
    const index = found + offset;
    const before = text.slice(0, index).split('\n');
    return { line: before.length - 1, character: before.at(-1).length };
  }
  const query = match => ({ textDocument: { uri: reader.uri }, position: position(reader.text, match, 1) });
  const symbols = normalizeSymbols(await lsp.request('textDocument/documentSymbol', { textDocument: { uri: reader.uri } }), reader.uri);
  assert.ok(symbols.some(symbol => symbol.name === 'process_request'));
  assert.ok(symbols.some(symbol => symbol.name === 'leaf'));
  t.diagnostic('Document symbols: verified with clangd');

  const definitions = (await lsp.request('textDocument/definition', query('leaf(request.value)'))).map(normalizeLocation);
  assert.ok(definitions.some(location => location.uri === reader.uri && location.range.start.line === 8));
  const types = await lsp.request('textDocument/typeDefinition', query('request.value)'));
  assert.ok(types.length);
  t.diagnostic('Definition and type definition: verified with clangd');

  const [leaf] = await lsp.request('textDocument/prepareCallHierarchy', query('leaf(int'));
  assert.ok(leaf);
  const incomingRaw = await lsp.request('callHierarchy/incomingCalls', { item: leaf });
  const incoming = normalizeCalls(leaf, incomingRaw, 'incoming', [locationKey({ uri: leaf.uri, range: leaf.selectionRange })]);
  const processCaller = incoming.find(node => node.name === 'process_request');
  assert.ok(processCaller);
  assert.equal(processCaller.sites.length, 2);
  assert.ok(processCaller.sites.every(site => site.uri === reader.uri));

  t.diagnostic('Incoming calls and two distinct call sites: verified with clangd');
  await t.test('outgoing calls require clangd 20+', { skip: major > 0 && major < 20 ? `Installed clangd ${major} does not implement outgoing calls` : false }, async () => {
    const [processRoot] = await lsp.request('textDocument/prepareCallHierarchy', query('process_request(const'));
    const outgoingRaw = await lsp.request('callHierarchy/outgoingCalls', { item: processRoot });
    const outgoing = normalizeCalls(processRoot, outgoingRaw, 'outgoing');
    const leafCallee = outgoing.find(node => node.name === 'leaf');
    assert.ok(leafCallee);
    assert.equal(leafCallee.sites.length, 2);
    assert.ok(leafCallee.sites.every(site => site.uri === reader.uri));
  });

  const [recursiveRoot] = await lsp.request('textDocument/prepareCallHierarchy', query('recurse(int'));
  const recursiveCalls = await lsp.request('callHierarchy/incomingCalls', { item: recursiveRoot });
  assert.ok(normalizeCalls(recursiveRoot, recursiveCalls, 'incoming', [
    locationKey({ uri: recursiveRoot.uri, range: recursiveRoot.selectionRange })
  ]).some(node => node.cycle));

  const references = uniqueLocations(await lsp.request('textDocument/references', {
    ...query('leaf(int'), context: { includeDeclaration: true }
  }));
  assert.ok(references.filter(location => location.uri === reader.uri).length >= 3);
  const main = documents.get('main.cpp');
  const outer = await lsp.request('textDocument/references', {
    textDocument: { uri: main.uri }, position: position(main.text, 'result = worker', 1), context: { includeDeclaration: true }
  });
  const inner = await lsp.request('textDocument/references', {
    textDocument: { uri: main.uri }, position: position(main.text, 'result = helper', 1), context: { includeDeclaration: true }
  });
  assert.equal(outer.some(a => inner.some(b => locationKey(a) === locationKey(b))), false);
  t.diagnostic('Reference locations and shadowed local variables: verified with clangd');
});
