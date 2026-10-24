'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
async function waitFor(action, accept, description) {
  const deadline = Date.now() + 120000; let value, lastError;
  while (Date.now() < deadline) {
    try { value = await action(); if (accept(value)) return value; } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Language provider did not become ready: ${description}; ${lastError || ''}`);
}
async function run() {
  const profile = process.env.SOURCEINSIGHT_READER_LANGUAGE, results = [];
  const report = { vscode: vscode.version, platform: process.platform, profile, completed: false, results };
  const check = async (name, action) => {
    const started = Date.now();
    try { await action(); results.push({ name, passed: true, elapsedMs: Date.now() - started }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); throw error; }
  };
  try {
    const extension = vscode.extensions.getExtension('wanguo.wanguo-sourceinsight-reader'), app = await extension.activate();
    const ids = profile === 'java' ? ['redhat.java'] : ['ms-python.python', 'ms-python.vscode-pylance'];
    for (const id of ids) { const provider = vscode.extensions.getExtension(id); assert(provider, id); await provider.activate(); }
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, profile === 'java' ? 'Main.java' : 'main.py');
    const document = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(document);
    const offset = document.getText().indexOf(profile === 'java' ? 'return leaf' : 'return leaf') + 7, position = document.positionAt(offset);
    await check('real provider symbols and cross-method definition preview', async () => {
      const nodes = await waitFor(() => app.language.symbols(uri), nodes => nodes.length > 0, 'symbols'); assert(nodes.length);
      const values = await waitFor(() => app.language.definitions(uri, position), values => values.length > 0, 'definition');
      assert.equal(values[0].uri.toString(), uri.toString()); assert(values[0].range.start.line < position.line);
      await app.preview.definition({ uri, range: new vscode.Range(position, position) }); assert(app.preview.current);
    });
    await check('real provider references, workspace symbols and both call directions', async () => {
      const refs = await waitFor(() => app.language.references(uri, position), values => values.length >= 2, 'references'); assert(refs.length >= 2);
      assert((await waitFor(() => app.language.workspaceSymbols('leaf'), values => values.some(value => value.name.includes('leaf')), 'workspace symbols')).length);
      const prepared = await waitFor(() => vscode.commands.executeCommand('vscode.prepareCallHierarchy', uri, position), values => values?.length, 'call hierarchy');
      const incoming = await waitFor(() => vscode.commands.executeCommand('vscode.provideIncomingCalls', prepared[0]), values => values?.length, 'incoming'); assert(incoming.length);
      const caller = incoming[0].from;
      const outgoing = await waitFor(() => vscode.commands.executeCommand('vscode.provideOutgoingCalls', caller), values => values?.length, 'outgoing'); assert(outgoing.length);
    });
    report.completed = true;
  } finally {
    report.passed = results.filter(value => value.passed).length;
    const file = process.env.SOURCEINSIGHT_READER_REPORT;
    if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2)); }
  }
}
module.exports = { run };
