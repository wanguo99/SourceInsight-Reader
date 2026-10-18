'use strict';
const vscode = require('vscode');
const { normalizeLocation, normalizeSymbols, uniqueLocations } = require('./core');
const { augmentDocumentSymbols } = require('./document-symbols');

class LanguageAdapter {
  async workspaceSymbols(query) {
    /** @type {import('vscode').SymbolInformation[]} */
    const result = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query);
    return result || [];
  }
  async symbols(uri) {
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    /** @type {(import('vscode').DocumentSymbol | import('vscode').SymbolInformation)[]} */
    const values = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
    const nodes = normalizeSymbols(values || [], uri);
    return ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp'].includes(document.languageId)
      ? augmentDocumentSymbols(nodes, text, uri, (a, b, c, d) => new vscode.Range(a, b, c, d)) : nodes;
  }
  async definitions(uri, position, type = false) {
    /** @type {(import('vscode').Location | import('vscode').LocationLink)[]} */
    const values = await vscode.commands.executeCommand(
      type ? 'vscode.executeTypeDefinitionProvider' : 'vscode.executeDefinitionProvider', uri, position);
    return uniqueLocations((values || []).map(normalizeLocation));
  }
  async prepare(uri, position) {
    /** @type {import('vscode').CallHierarchyItem[]} */
    const result = await vscode.commands.executeCommand('vscode.prepareCallHierarchy', uri, position);
    return result || [];
  }
  async calls(item, direction) {
    return await vscode.commands.executeCommand(
      direction === 'incoming' ? 'vscode.provideIncomingCalls' : 'vscode.provideOutgoingCalls', item) || [];
  }
  async references(uri, position) {
    return uniqueLocations(await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position) || []);
  }
}
module.exports = { LanguageAdapter };
