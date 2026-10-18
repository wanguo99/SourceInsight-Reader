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
  async declarations(uri, position) {
    /** @type {(import('vscode').Location | import('vscode').LocationLink)[]} */
    const values = await vscode.commands.executeCommand('vscode.executeDeclarationProvider', uri, position);
    return uniqueLocations((values || []).map(normalizeLocation));
  }
  async contextDefinitions(uri, position, type = false) {
    // A function's type definition can be its return type: keep function targets on their definitions.
    const [definitions, types] = await Promise.all([
      this.definitions(uri, position).catch(() => []),
      this.definitions(uri, position, true).catch(() => [])
    ]);
    if (type) return { locations: types, mode: '类型定义' };
    if (!type && types.length) {
      let functionTarget = false;
      for (const location of definitions) {
        const nodes = await this.symbols(location.uri).catch(() => []);
        const matches = values => values.some(node => {
          const a = node.selectionRange.start, b = node.selectionRange.end, p = location.range.start;
          const atName = (p.line > a.line || p.line === a.line && p.character >= a.character) &&
            (p.line < b.line || p.line === b.line && p.character <= b.character);
          const atStart = p.line === node.range.start.line && p.character === node.range.start.character;
          return [5, 8, 11].includes(node.kind) && (atName || atStart) || matches(node.children);
        });
        if (matches(nodes)) { functionTarget = true; break; }
      }
      if (!functionTarget) return { locations: types, mode: '类型定义' };
    }
    if (definitions.length) return { locations: definitions, mode: '定义' };
    const declarations = await this.declarations(uri, position).catch(() => []);
    return { locations: declarations, mode: '声明' };
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
