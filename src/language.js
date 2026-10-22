'use strict';
const vscode = require('vscode');
const { rankSymbols } = require('./domain/symbol-search');
const { normalizeLocation, normalizeSymbols, uniqueLocations } = require('./core');
const { augmentDocumentSymbols } = require('./document-symbols');
const { scopedSettings } = require('./editor-color-settings');
const { TextmateColors } = require('./textmate-colors');

class LanguageAdapter {
  constructor(localIndex, catalog) { this.localIndex = localIndex; this.catalog = catalog; this.textmateColors = new TextmateColors(); }
  allowed(uri) { return !this.catalog || this.catalog.accepts(uri); }
  filterLocations(values) { return values.filter(value => this.allowed(value.uri)); }
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
      bounded(Promise.resolve().then(() => vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)), vscode.workspace.getConfiguration('sourceInsightReader').get('workspaceSymbolTimeoutMs', 5000))
    ]);
    const values = new Map();
    for (const item of [...local, ...(semantic || [])]) {
      if (!item.location?.range || !this.allowed(item.location.uri)) continue;
      const p = item.location.range.start;
      const key = `${item.location.uri.toString()}:${p.line}:${p.character}:${item.name}`;
      if (!values.has(key)) values.set(key, item);
    }
    return rankSymbols([...values.values()], query);
  }

  async symbols(uri) {
    if (!this.allowed(uri)) return [];
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
    if (!this.allowed(uri)) return [];
    const nodes = normalizeSymbols(values || [], uri);
    return ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp'].includes(document.languageId)
      ? augmentDocumentSymbols(nodes, text, uri, (a, b, c, d) => new vscode.Range(a, b, c, d)) : nodes;
  }
  async definitions(uri, position, type = false) {
    if (!this.allowed(uri)) return [];
    if (!type && this.localIndex?.enabled() && this.localIndex.supports(uri)) {
      try {
        const locations = await this.localIndex.definitions(uri, position);
        const filtered = this.allowed(uri) ? this.filterLocations(locations) : [];
        if (filtered.length) return filtered;
      } catch (error) { this.localIndex.log(`本地定义查询失败：${error.message}`); }
    }
    /** @type {(import('vscode').Location | import('vscode').LocationLink)[]} */
    const values = await vscode.commands.executeCommand(
      type ? 'vscode.executeTypeDefinitionProvider' : 'vscode.executeDefinitionProvider', uri, position);
    return this.allowed(uri) ? this.filterLocations(uniqueLocations((values || []).map(normalizeLocation))) : [];
  }
  async declarations(uri, position) {
    if (!this.allowed(uri)) return [];
    /** @type {(import('vscode').Location | import('vscode').LocationLink)[]} */
    const values = await vscode.commands.executeCommand('vscode.executeDeclarationProvider', uri, position);
    return this.allowed(uri) ? this.filterLocations(uniqueLocations((values || []).map(normalizeLocation))) : [];
  }
  async contextDefinitions(uri, position, type = false) {
    const log = message => this.localIndex?.log?.(`[Context] ${uri.toString()}:${position.line + 1}:${position.character + 1} ${message}`);
    log(`查询模式：${type ? '类型定义' : '定义'}`);
    if (!this.allowed(uri)) {
      log('源文件被项目范围过滤');
      return { locations: [], mode: '定义', note: '当前文件已被屏蔽或不在工作区内' };
    }
    if (!type && this.localIndex?.enabled() && this.localIndex.supports(uri)) {
      try {
        const locations = await this.localIndex.definitions(uri, position);
        const filtered = this.allowed(uri) ? this.filterLocations(locations) : [];
        log(`本地定义：${locations.length}，范围过滤后：${filtered.length}；${this.localIndex.describe?.(uri)?.note || ''}`);
        if (filtered.length) return { locations: filtered, mode: '定义' };
      } catch (error) { this.localIndex.log(`本地 Context 定义查询失败：${error.message}`); }
    }
    // Ordinary clicks always follow the selected symbol. Type navigation is
    // explicit so variables and fields do not skip their own declarations.
    if (type) {
      const locations = await this.definitions(uri, position, true).catch(() => []);
      return { locations, mode: '类型定义' };
    }
    const definitions = await this.definitions(uri, position).catch(() => []);
    log(`定义查询结果：${definitions.length}`);
    if (definitions.length) return { locations: definitions, mode: '定义' };
    const declarations = await this.declarations(uri, position).catch(() => []);
    log(`语言服务声明：${declarations.length}`);
    return { locations: declarations, mode: '声明' };
  }
  async references(uri, position) {
    if (!this.allowed(uri)) return [];
    const values = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position) || [];
    return this.allowed(uri) ? this.filterLocations(uniqueLocations(values)) : [];
  }
  textmateTokens(document, start, end) { return this.allowed(document.uri) ? this.textmateColors.colorize(document, start, end) : Promise.resolve([]); }
  dispose() { this.textmateColors.dispose(); }
  async semanticTokens(uri, languageId) {
    if (!this.allowed(uri)) return [];
    const config = vscode.workspace.getConfiguration('editor', { uri, languageId });
    const enabled = config.get('semanticHighlighting.enabled', /** @type {string | boolean} */ ('configuredByTheme'));
    const custom = vscode.workspace.getConfiguration('editor').get('semanticTokenColorCustomizations', /** @type {any} */ ({}));
    const layers = scopedSettings(custom);
    const customized = layers.reduce((value, layer) => layer.enabled ?? value, true);
    if (enabled === false || enabled === 'configuredByTheme' && customized === false) return [];
    const { semanticSpans } = require('./preview-colors');
    const request = Promise.all([
      /** @type {Thenable<import('vscode').SemanticTokensLegend>} */ (vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', uri)),
      /** @type {Thenable<import('vscode').SemanticTokens>} */ (vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri))
    ]).then(([legend, tokens]) => this.allowed(uri) ? semanticSpans(legend, tokens?.data) : []);
    let timer;
    try { return await Promise.race([request, new Promise(resolve => { timer = setTimeout(() => resolve([]), 1500); })]); }
    finally { clearTimeout(timer); }
  }
}
module.exports = { LanguageAdapter };
