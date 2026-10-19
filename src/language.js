'use strict';
const vscode = require('vscode');
const { rankSymbols } = require('./domain/symbol-search');
const { normalizeLocation, normalizeSymbols, uniqueLocations } = require('./core');
const { augmentDocumentSymbols } = require('./document-symbols');

class LanguageAdapter {
  constructor(localIndex) { this.localIndex = localIndex; }
  async workspaceSymbols(query) {
    // Both providers are bounded independently. A broken language server must
    // not hide the available local C symbols, nor delay their display forever.
    const bounded = async (promise, timeout) => {
      let timer;
      try { return await Promise.race([promise.catch(() => []), new Promise(resolve => { timer = setTimeout(() => resolve([]), timeout); })]); }
      finally { clearTimeout(timer); }
    };
    const [local, semantic] = await Promise.all([
      this.localIndex?.enabled() ? bounded(this.localIndex.workspaceSymbols(query), 5000) : [],
      bounded(Promise.resolve().then(() => vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)), 800)
    ]);
    const values = new Map();
    for (const item of [...local, ...(semantic || [])]) {
      if (!item.location?.range) continue;
      const p = item.location.range.start;
      const key = `${item.location.uri.toString()}:${p.line}:${p.character}:${item.name}`;
      if (!values.has(key)) values.set(key, item);
    }
    return rankSymbols([...values.values()], query);
  }

  async symbols(uri) {
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    /** @type {(import('vscode').DocumentSymbol | import('vscode').SymbolInformation)[]} */
    let values;
    /** @type {Promise<Array<import('vscode').DocumentSymbol | import('vscode').SymbolInformation>>} */
    const semantic = Promise.resolve().then(() => vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri));
    if (this.localIndex?.enabled() && this.localIndex.supports(uri)) {
      const local = this.localIndex.symbols(uri).catch(error => {
        this.localIndex.log(`本地文件符号查询失败：${error.message}`); return [];
      });
      let timer;
      const bounded = Promise.race([semantic, new Promise(resolve => { timer = setTimeout(() => resolve([]), 1500); })]);
      try {
        // A stalled symbol provider must not block acceptEditor/reloadSymbols,
        // which would prevent even the independent Relation query from starting.
        values = await Promise.race([
          bounded.then(result => result?.length ? result : local),
          local.then(result => result.length ? result : bounded)
        ]);
      } catch (error) {
        this.localIndex.log(`语言服务文件符号查询失败：${error.message}`); values = await local;
      } finally { clearTimeout(timer); }
    } else values = await semantic;
    const nodes = normalizeSymbols(values || [], uri);
    return ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp'].includes(document.languageId)
      ? augmentDocumentSymbols(nodes, text, uri, (a, b, c, d) => new vscode.Range(a, b, c, d)) : nodes;
  }
  async definitions(uri, position, type = false) {
    if (!type && this.localIndex?.enabled() && this.localIndex.supports(uri)) {
      try {
        const locations = await this.localIndex.definitions(uri, position);
        if (locations.length) return locations;
      } catch (error) { this.localIndex.log(`本地函数定义查询失败：${error.message}`); }
    }
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
    if (!type && this.localIndex?.enabled() && this.localIndex.supports(uri)) {
      try {
        const locations = await this.localIndex.definitions(uri, position);
        if (locations.length) return { locations, mode: '定义' };
      } catch (error) { this.localIndex.log(`本地 Context 函数查询失败：${error.message}`); }
    }
    const [definitions, types] = await Promise.all([
      this.definitions(uri, position).catch(() => []),
      this.definitions(uri, position, true).catch(() => [])
    ]);
    if (type) return { locations: types, mode: '类型定义' };
    // Only aggregate types are useful automatic previews. Scalar typedefs (e.g. size_t)
    // must not hide the variable/array initializer the reader actually selected.
    const matchesKind = async (locations, kinds) => {
      for (const location of locations) {
        const nodes = await this.symbols(location.uri).catch(() => []);
        const candidates = [];
        const visit = values => { for (const node of values) {
          const a = node.selectionRange.start, b = node.selectionRange.end, p = location.range.start;
          const atName = (p.line > a.line || p.line === a.line && p.character >= a.character) &&
            (p.line < b.line || p.line === b.line && p.character <= b.character);
          const atStart = p.line === node.range.start.line && p.character === node.range.start.character;
          if (kinds.includes(node.kind) && (atName || atStart)) candidates.push(node);
          visit(node.children);
        } };
        visit(nodes);
        for (const node of candidates) {
          if (node.kind !== 4 || ['struct', 'union'].includes(node.category)) return true;
          // Some providers use Class for typedefs too. Require an actual record declaration.
          const document = await Promise.resolve(vscode.workspace.openTextDocument(location.uri)).catch(() => undefined);
          if (!document) continue;
          const point = node.selectionRange.start;
          const prefix = document.lineAt(point.line).text.slice(0, point.character);
          if (/\b(class|struct|union)\s*$/.test(prefix)) return true;
        }
      }
      return false;
    };
    if (types.length && !await matchesKind(definitions, [5, 8, 11]) &&
      await matchesKind(types, [4, 9, 10, 22])) {
      return { locations: types, mode: '类型定义' };
    }
    if (definitions.length) return { locations: definitions, mode: '定义' };
    const declarations = await this.declarations(uri, position).catch(() => []);
    return { locations: declarations, mode: '声明' };
  }
  async references(uri, position) {
    return uniqueLocations(await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position) || []);
  }
}
module.exports = { LanguageAdapter };
