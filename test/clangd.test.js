'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { LspClient } = require('./lsp-client');
const { execFile } = require('node:child_process');
const { normalizeSymbols, normalizeLocation, normalizeCalls, uniqueLocations, locationKey } = require('../src/core');
const { sameUri } = require('../src/resources');
const { augmentDocumentSymbols, symbolCategory } = require('../src/document-symbols');
const { filterSymbols } = require('../src/core');

test('real clangd: symbols, definitions, calls, references and cycles', async t => {
  const executable = process.env.CLANGD_PATH || 'clangd';
  const probe = await new Promise(resolve => execFile(executable, ['--version'], { encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  if (probe.error?.code === 'ENOENT' && process.env.SOURCEINSIGHT_READER_REQUIRE_CLANGD !== '1') {
    t.skip('clangd not installed; use npm run test:clangd to require it'); return;
  }
  if (probe.error) throw probe.error;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sourceinsight-reader-lsp-'));
  const root = path.join(temporary, 'C++ 源码 workspace');
  fs.cpSync(path.resolve(__dirname, '../examples/cpp'), root, { recursive: true,
    filter: source => !['build', '.cache', 'compile_commands.json'].includes(path.basename(source)) });
  const cRoot = path.join(root, 'c');
  fs.cpSync(path.resolve(__dirname, '../examples/c'), cRoot, { recursive: true });
  for (const name of ['reader.h', 'main.cpp', 'reader.cpp']) {
    const file = path.join(root, name);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
  }
  const lsp = new LspClient(executable, ['--background-index=false', '--log=error'], root);
  t.after(async () => { await lsp.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
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
  if (process.env.SOURCEINSIGHT_READER_REQUIRE_OUTGOING === '1' && major < 20) throw new Error('clangd 20+ is required for this quality gate');
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
  // VS Code translates LSP SymbolKind (1-based) to vscode.SymbolKind (0-based).
  const vscodeSymbols = values => values.map(value => ({ ...value, kind: value.kind - 1,
    children: value.children ? vscodeSymbols(value.children) : [] }));
  function position(text, match, offset = 0) {
    const found = text.indexOf(match);
    assert.ok(found >= 0);
    const index = found + offset;
    const before = text.slice(0, index).split('\n');
    return { line: before.length - 1, character: before.at(-1).length };
  }
  const query = match => ({ textDocument: { uri: reader.uri }, position: position(reader.text, match, 1) });
  const symbols = normalizeSymbols(vscodeSymbols(await lsp.request('textDocument/documentSymbol', { textDocument: { uri: reader.uri } })), reader.uri);
  assert.ok(symbols.some(symbol => symbol.name === 'process_request'));
  assert.ok(symbols.some(symbol => symbol.name === 'leaf'));
  t.diagnostic('Document symbols: verified with clangd');

  const definitions = (await lsp.request('textDocument/definition', query('leaf(request.value)'))).map(normalizeLocation);
  assert.ok(definitions.some(location => sameUri(location.uri, reader.uri) && location.range.start.line === 8));
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
  assert.ok(processCaller.sites.every(site => sameUri(site.uri, reader.uri)));

  t.diagnostic('Incoming calls and two distinct call sites: verified with clangd');
  await t.test('outgoing calls require clangd 20+', { skip: major > 0 && major < 20 ? `Installed clangd ${major} does not implement outgoing calls` : false }, async () => {
    const [processRoot] = await lsp.request('textDocument/prepareCallHierarchy', query('process_request(const'));
    const outgoingRaw = await lsp.request('callHierarchy/outgoingCalls', { item: processRoot });
    const outgoing = normalizeCalls(processRoot, outgoingRaw, 'outgoing');
    const leafCallee = outgoing.find(node => node.name === 'leaf');
    assert.ok(leafCallee);
    assert.equal(leafCallee.sites.length, 2);
    assert.ok(leafCallee.sites.every(site => sameUri(site.uri, reader.uri)));
  });

  const [recursiveRoot] = await lsp.request('textDocument/prepareCallHierarchy', query('recurse(int'));
  const recursiveCalls = await lsp.request('callHierarchy/incomingCalls', { item: recursiveRoot });
  assert.ok(normalizeCalls(recursiveRoot, recursiveCalls, 'incoming', [
    locationKey({ uri: recursiveRoot.uri, range: recursiveRoot.selectionRange })
  ]).some(node => node.cycle));

  const references = uniqueLocations(await lsp.request('textDocument/references', {
    ...query('leaf(int'), context: { includeDeclaration: true }
  }));
  assert.ok(references.filter(location => sameUri(location.uri, reader.uri)).length >= 3);
  const main = documents.get('main.cpp');
  const outer = await lsp.request('textDocument/references', {
    textDocument: { uri: main.uri }, position: position(main.text, 'result = worker', 1), context: { includeDeclaration: true }
  });
  const inner = await lsp.request('textDocument/references', {
    textDocument: { uri: main.uri }, position: position(main.text, 'result = helper', 1), context: { includeDeclaration: true }
  });
  assert.equal(outer.some(a => inner.some(b => locationKey(a) === locationKey(b))), false);
  t.diagnostic('Reference locations and shadowed local variables: verified with clangd');

  await t.test('C file outline: include, macros, globals, structs, typedefs, enums and functions', async () => {
    let cDocument;
    for (const name of ['outline.h', 'outline.c']) {
      const file = path.join(cRoot, name);
      const text = fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n');
      const uri = pathToFileURL(file).href;
      lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'c', version: 1, text } });
      if (name.endsWith('.c')) cDocument = { uri, text };
    }
    const raw = await lsp.request('textDocument/documentSymbol', { textDocument: { uri: cDocument.uri } });
    const semantic = normalizeSymbols(vscodeSymbols(raw), cDocument.uri);
    const makeRange = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } });
    const nodes = augmentDocumentSymbols(semantic, cDocument.text, cDocument.uri, makeRange);
    const visible = filterSymbols(nodes, '', 'position', undefined, true);
    for (const name of ['#include "outline.h"', 'MAX_DEVICES', 'DOUBLE', 'ADD_OFFSET', 'device_count', 'device_label', 'Device', 'Packet', 'Mode', 'process_device']) {
      assert.ok(visible.some(node => node.name === name), `C outline missing: ${name}`);
    }
    assert.equal(symbolCategory(visible.find(node => node.name === 'Device')), '结构体');
    assert.equal(symbolCategory(visible.find(node => node.name === 'device_count')), '全局变量');
    assert.equal(nodes.filter(node => node.name === 'MAX_DEVICES').length, 1);
    assert.ok(visible.find(node => node.name === 'Device').children.some(node => node.name === 'id'));
  });
  await t.test('Context resolves struct-returning function calls and struct parameters with real clangd', async () => {
    const { fakeVscode, loadWithVscode } = require('./fake-vscode');
    const env = fakeVscode();
    const { LanguageAdapter } = loadWithVscode('../src/language', env.api);
    const text = 'struct Node { int value; };\r\nstruct Node make(void) { return (struct Node){0}; }\r\nint use(struct Node *node) { struct Node result = make(); return node->value; }\r\n';
    const uri = pathToFileURL(path.join(cRoot, 'context.c')).href;
    const contextDocument = env.document('context.c', text);
    contextDocument.uri = new env.api.Uri(uri);
    env.documents.set(uri, contextDocument);
    env.documents.set(uri.replace(/\+/g, '%2B'), contextDocument);
    fs.writeFileSync(path.join(cRoot, 'context.c'), text);
    lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'c', version: 1, text } });
    const adapter = new LanguageAdapter();
    adapter.definitions = async (resource, point, type) => {
      const values = await lsp.request(type ? 'textDocument/typeDefinition' : 'textDocument/definition', {
        textDocument: { uri: String(resource) }, position: point });
      return (values || []).map(normalizeLocation);
    };
    adapter.symbols = async resource => normalizeSymbols(vscodeSymbols(await lsp.request('textDocument/documentSymbol', {
      textDocument: { uri: String(resource) } })), resource);
    const fn = await adapter.contextDefinitions(uri, position(text, 'make();', 1));
    assert.equal(fn.mode, '定义'); assert.equal(fn.locations[0].range.start.line, 1);
    const record = await adapter.contextDefinitions(uri, position(text, 'node->', 1));
    assert.equal(record.mode, '定义'); assert.equal(record.locations[0].range.start.line, 2);
    assert.equal(record.locations[0].range.start.character, text.split('\r\n')[2].indexOf('node)'));
    const field = await adapter.contextDefinitions(uri, position(text, 'node->value', 7));
    assert.equal(field.mode, '定义'); assert.equal(field.locations[0].range.start.line, 0);
    const explicit = await adapter.contextDefinitions(uri, position(text, 'node->', 1), true);
    assert.equal(explicit.locations[0].range.start.line, 0);
  });

});

test('clangd enum diagnostics clear when the project compilation database supplies its include directory', async t => {
  const executable = process.env.CLANGD_PATH || 'clangd';
  const probe = await new Promise(resolve => execFile(executable, ['--version'], error => resolve(error)));
  if (probe?.code === 'ENOENT' && process.env.SOURCEINSIGHT_READER_REQUIRE_CLANGD !== '1') { t.skip('clangd unavailable'); return; }
  if (probe) throw probe;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-clangd-enum-'));
  const header = path.join(root, 'include/bmc/epdu/bmc_epdu.h'), file = path.join(root, 'src/epdu/command.c'), database = path.join(root, 'database');
  fs.mkdirSync(path.dirname(header), { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.mkdirSync(database);
  const name = 'BMC_EPDU_COMMAND_POWER_STAT_GET';
  fs.writeFileSync(header, `enum bmc_epdu_command_id {\n  ${name} = 0xf083\n};\n`);
  const text = `#include <bmc/epdu/bmc_epdu.h>\nint query(void){return ${name};}\n`; fs.writeFileSync(file, text);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uri = pathToFileURL(file).href;
  for (const configured of [false, true]) {
    if (configured) fs.writeFileSync(path.join(database, 'compile_commands.json'), JSON.stringify([{ directory: root, file, arguments: ['cc', '-I' + path.join(root, 'include'), '-c', file] }]));
    const lsp = new LspClient(executable, ['--enable-config=false', '--background-index=false', '--log=error', '--compile-commands-dir=' + database], root);
    let diagnostics;
    lsp.onNotification = (method, params) => { if (method === 'textDocument/publishDiagnostics' && params.uri === uri) diagnostics = params.diagnostics; };
    try {
      await lsp.request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {} }); lsp.notify('initialized', {});
      lsp.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'c', version: 1, text } });
      await lsp.request('textDocument/documentSymbol', { textDocument: { uri } });
      const deadline = Date.now() + 5000; while (!diagnostics && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert(diagnostics, 'clangd must publish editor diagnostics');
      if (!configured) assert(diagnostics.some(item => item.message.includes(name) && /undeclared/i.test(item.message)));
      else {
        assert.deepEqual(diagnostics.filter(item => item.severity === 1), []);
        const values = await lsp.request('textDocument/definition', { textDocument: { uri }, position: { line: 1, character: text.split('\n')[1].indexOf(name) } });
        assert(values.map(normalizeLocation).some(value => value.uri.toString() === pathToFileURL(header).href && value.range.start.line === 1));
      }
    } finally { await lsp.close(); }
  }
});
