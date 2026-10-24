'use strict';
const vscode = require('vscode');
const { rankSymbols } = require('./domain/symbol-search');
const { normalizeLocation, normalizeSymbols, uniqueLocations } = require('./core');
const { augmentDocumentSymbols } = require('./document-symbols');
const { TextmateColors } = require('./textmate-colors');
const { QueryCoordinator } = require('./infrastructure/query-coordinator');
const { uriKey } = require('./resources');
const { LocalCColors, semanticColoringEnabled } = require('./local-c-colors');

class LanguageAdapter {
  constructor(localIndex, catalog) {
    this.localIndex = localIndex; this.catalog = catalog; this.textmateColors = new TextmateColors(); this.localCColors = new LocalCColors();
    this.semanticColorRequests = new WeakMap(); this.semanticColorSnapshots = new WeakMap(); this.semanticColorInflight = new Map();
    this.queries = new QueryCoordinator(); this.queryStates = new Map(); this.symbolSnapshots = new WeakMap();
    this.subscription = catalog?.onDidChange?.(event => {
      if (event.kind === 'close' || event.kind === 'save') return;
      if (event.kind === 'config' && !['clangd', 'C_Cpp', 'files.associations', 'sourceInsightReader.navigationBackend',
        'sourceInsightReader.queryTimeoutMs', 'sourceInsightReader.indexEnabled', 'sourceInsightReader.indexExclude',
        'sourceInsightReader.indexMemoryLimitMb', 'sourceInsightReader.excludedDirectories', 'sourceInsightReader.excludedFiles'].some(key => event.configuration.affectsConfiguration(key))) return;
      // Settings writes also arrive as generic filesystem notifications. Their
      // semantic impact is already handled by the configuration event above.
      if (event.uri && /(?:^|\/)\.vscode\/settings\.json$/.test(event.uri.path)) return;
      if (event.uri && ['create', 'change', 'delete'].includes(event.kind) &&
        !/\.(?:c|h|cc|cpp|cxx|hpp|hxx|java|py|pyi|js|jsx|ts|tsx|cs|rs|go|m|mm)$/i.test(event.uri.path) &&
        !/(?:\.clangd|compile_commands\.json|compile_flags\.txt|CMake(?:User)?Presets\.json|c_cpp_properties\.json|pom\.xml|build\.gradle|pyproject\.toml)$/.test(event.uri.path)) return;
      if (event.uri && /(?:^|\/)(?:\.git|\.cache|node_modules|build|dist|out|research)(?:\/|$)/.test(event.uri.path) &&
        !/(?:compile_commands\.json|compile_flags\.txt|\.clangd)$/.test(event.uri.path)) return;
      // A delayed create notification for an already-open, indexed document
      // does not supersede the text version used by an in-flight query.
      if (event.kind === 'create' && catalog.document?.(event.uri) && this.localIndex?.coverage?.has(uriKey(event.uri))) return;
      this.lastInvalidation = `${event.kind}:${event.uri?.toString() || 'configuration'}`;
      this.queries.invalidate(); this.queryStates.clear();
    });
  }
  mode() { return vscode.workspace.getConfiguration('sourceInsightReader').get('navigationBackend', 'auto'); }
  timeout() { return vscode.workspace.getConfiguration('sourceInsightReader').get('queryTimeoutMs', 5000); }
  queryInfo(kind, uri) { return this.queryStates.get(`${kind}:${uri?.toString() || ''}`); }
  query(kind, uri, action, timeout = this.timeout(), channel = 'semantic', extra = '', retried = false) {
    const stateKey = `${kind}:${uri?.toString() || ''}`, version = uri ? this.catalog?.document?.(uri)?.version || 0 : 0;
    const key = `${stateKey}:${version}:${extra}:${this.catalog?.configurationKey?.(uri) || ''}`;
    const started = Date.now(), epoch = this.queries.epoch, mode = this.mode();
    return this.queries.run(key, action, { timeout, channel }).then(value => {
      if (this.queries.epoch === epoch) this.record(stateKey, { status: value === undefined ? 'unsupported' : value?.length ? 'ready' : 'empty',
        provider: channel === 'local' ? 'local' : 'languageService', elapsedMs: Date.now() - started });
      return value;
    }, error => {
      // File watchers can deliver an earlier disk event after an open document
      // has already supplied the current text. Retry once within the original
      // budget, using a new query generation, only while the source is unchanged.
      if (error.code === 'cancelled' && !retried && !this.disposed && uri && this.mode() === mode &&
        this.catalog?.document?.(uri)?.version === version && Date.now() - started < timeout) {
        return this.query(kind, uri, action, Math.max(1, timeout - (Date.now() - started)), channel, extra, true);
      }
      this.localIndex?.log?.(`[Query] ${kind} ${channel}: ${error.message}${error.code === 'cancelled' ? ' · ' + this.lastInvalidation : ''}`);
      if (this.queries.epoch === epoch) this.record(stateKey, { status: error.code || 'error', provider: channel === 'local' ? 'local' : 'languageService',
        elapsedMs: Date.now() - started, note: error.message });
      throw error;
    });
  }
  record(key, value) {
    this.queryStates.set(key, value); if (this.queryStates.size > 64) this.queryStates.delete(this.queryStates.keys().next().value);
    this.localIndex?.log?.(JSON.stringify({ event: 'query', kind: key.split(':')[0], status: value.status, provider: value.provider, elapsedMs: value.elapsedMs }));
  }
  async semanticDefinitions(uri, position, type) {
    const guard = type ? undefined : this.localIndex?.beginSemanticQuery?.(uri, position);
    try { return await vscode.commands.executeCommand(type ? 'vscode.executeTypeDefinitionProvider' : 'vscode.executeDefinitionProvider', uri, position); }
    finally { guard?.dispose(); }
  }
  allowed(uri) { return !this.catalog || this.catalog.accepts(uri); }
  filterLocations(values) { return values.filter(value => this.allowed(value.uri)); }
  cachedSymbols(document) {
    if (!document) return [];
    const cached = this.symbolSnapshots.get(document);
    return this.allowed(document.uri) && cached?.version === document.version && cached.language === document.languageId && cached.configuration === this.catalog?.configurationKey?.(document.uri) &&
      cached.scope === this.catalog?.scopeKey?.() ? cached.nodes : [];
  }
  async workspaceSymbols(query) {
    // Both providers are bounded independently. A broken language server must
    // not hide the available local C symbols, nor delay their display forever.
    const bounded = async (promise, timeout) => {
      let timer;
      try { return await Promise.race([promise.catch(() => []), new Promise(resolve => { timer = setTimeout(() => resolve([]), timeout); })]); }
      finally { clearTimeout(timer); }
    };
    const [local, semantic] = await Promise.all([
      this.localIndex?.enabled() && this.mode() !== 'languageService' ? bounded(this.query('workspaceSymbols', undefined, () => this.localIndex.workspaceSymbols(query), 5000, 'local', query), 5000) : [],
      this.mode() !== 'local' ? bounded(this.query('workspaceSymbols', undefined, () => vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query),
        vscode.workspace.getConfiguration('sourceInsightReader').get('workspaceSymbolTimeoutMs', 5000), 'semantic', query),
        vscode.workspace.getConfiguration('sourceInsightReader').get('workspaceSymbolTimeoutMs', 5000)) : []
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
    const semantic = this.mode() === 'local' ? Promise.resolve([]) : this.query('symbols', uri,
      () => vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri), Math.min(this.timeout(), 1500));
    if (this.mode() !== 'languageService' && this.localIndex?.enabled() && this.localIndex.supports(uri)) {
      const local = this.query('symbols', uri, () => this.localIndex.symbols(uri), Math.min(this.timeout(), 2000), 'local').catch(error => {
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
    const result = ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp'].includes(document.languageId)
      ? augmentDocumentSymbols(nodes, text, uri, (a, b, c, d) => new vscode.Range(a, b, c, d)) : nodes;
    if (result.length) this.symbolSnapshots.set(document, { version: document.version, language: document.languageId, configuration: this.catalog?.configurationKey?.(uri), scope: this.catalog?.scopeKey?.(), nodes: result });
    return result;
  }
  async definitions(uri, position, type = false) {
    if (!this.allowed(uri)) return [];
    const semantic = async () => {
      const kind = type ? 'typeDefinitions' : 'definitions';
      const values = await this.query(kind, uri, () => this.semanticDefinitions(uri, position, type),
      this.mode() === 'auto' ? Math.min(500, this.timeout()) : this.timeout(), 'semantic', `${position.line}:${position.character}`);
      return this.allowed(uri) ? this.filterLocations(uniqueLocations((values || []).map(normalizeLocation)))
        .map(value => ({ ...value, provider: 'languageService', quality: 'semantic' })) : [];
    };
    let failure;
    if (this.mode() !== 'local') {
      try {
        const values = await semantic();
        if (values.length || type || this.mode() === 'languageService') return values;
      } catch (error) { if (this.mode() === 'languageService' || type || error.code === 'cancelled') throw error; failure = error; }
    }
    if (!type && this.mode() !== 'languageService' && this.localIndex?.enabled() && this.localIndex.supports(uri)) {
      try {
        const locations = await this.query('definitions', uri, () => this.localIndex.definitions(uri, position), Math.min(2000, this.timeout()), 'local', `${position.line}:${position.character}`);
        const filtered = this.allowed(uri) ? this.filterLocations(locations) : [];
        if (filtered.length) return filtered.map(value => ({ ...value, provider: 'local', quality: 'syntax' }));
      } catch (error) { this.localIndex.log(`本地定义查询失败：${error.message}`); failure = error; }
    }
    if (failure) throw failure;
    return [];
  }
  async declarations(uri, position) {
    if (!this.allowed(uri)) return [];
    /** @type {(import('vscode').Location | import('vscode').LocationLink)[]} */
    if (this.mode() === 'local') return [];
    const values = await this.query('declarations', uri, () => vscode.commands.executeCommand('vscode.executeDeclarationProvider', uri, position),
      this.mode() === 'auto' ? Math.min(500, this.timeout()) : this.timeout(), 'semantic', `${position.line}:${position.character}`);
    return this.allowed(uri) ? this.filterLocations(uniqueLocations((values || []).map(normalizeLocation))) : [];
  }
  async contextDefinitions(uri, position, type = false) {
    const log = message => this.localIndex?.log?.(`[Context] ${uri.toString()}:${position.line + 1}:${position.character + 1} ${message}`);
    log(`查询模式：${type ? '类型定义' : '定义'}`);
    if (!this.allowed(uri)) {
      log('源文件被项目范围过滤');
      return { locations: [], mode: '定义', note: '当前文件已被屏蔽或不在工作区内' };
    }
    // Ordinary clicks always follow the selected symbol. Type navigation is
    // explicit so variables and fields do not skip their own declarations.
    if (type) {
      const locations = await this.definitions(uri, position, true);
      return { locations, mode: '类型定义' };
    }
    const definitions = await this.definitions(uri, position);
    log(`定义查询结果：${definitions.length}`);
    if (definitions.length) return { locations: definitions, mode: '定义', provider: definitions[0].provider,
      note: definitions[0].provider === 'local' ? `本地 C 语法索引 · 条件分支未求值${this.localIndex?.summary?.memoryLimited ? ' · 内存预算限制，工程结果不完整' : this.localIndex?.phase === 'building' ? ' · 工程索引未完成，当前为部分结果' : ''}` : '语言服务查询' };
    const declarations = await this.declarations(uri, position);
    log(`语言服务声明：${declarations.length}`);
    return { locations: declarations, mode: '声明', note: !declarations.length && this.queryInfo('declarations', uri)?.status === 'unsupported'
      ? '语言服务不支持此查询或尚未就绪，请检查工程配置；本地 C 查询也未找到目标' : '' };
  }
  async references(uri, position) {
    if (!this.allowed(uri)) return [];
    let failure;
    if (this.mode() !== 'local') {
      try {
        const values = await this.query('references', uri, () => vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position), this.timeout(), 'semantic', `${position.line}:${position.character}`);
        if (values?.length || this.mode() === 'languageService') return this.allowed(uri) ? this.filterLocations(uniqueLocations(values || [])) : [];
        // VS Code returns [] both for no provider and a confirmed empty result.
        // Keep an empty semantic result when the same symbol resolves through
        // a semantic definition provider; otherwise expose the bound C fallback.
        if (values !== undefined) {
          const definitions = await this.query('referenceCapability', uri, () => this.semanticDefinitions(uri, position, false), Math.min(500, this.timeout()), 'semantic', `${position.line}:${position.character}`);
          if (definitions?.length) return [];
        }
      } catch (error) { if (this.mode() === 'languageService' || error.code === 'cancelled') throw error; failure = error; }
    }
    if (this.localIndex?.enabled() && this.localIndex.supports(uri) && this.localIndex.references) {
      const result = await this.query('references', uri, () => this.localIndex.references(uri, position), this.timeout(), 'local', `${position.line}:${position.character}`);
      this.record(`references:${uri.toString()}`, { provider: 'local', status: result.ambiguous ? 'ambiguous' : result.locations.length ? 'ready' : 'empty',
        note: '本地 C 绑定引用 · 包含声明 · 条件分支未求值' + (result.incomplete ? ' · 结果不完整（内存、时间或数量预算）' : '') });
      return this.allowed(uri) ? this.filterLocations(uniqueLocations(result.locations.map(location => ({ uri: vscode.Uri.parse(location.uri),
        range: new vscode.Range(location.range.start.line, location.range.start.character, location.range.end.line, location.range.end.character) })))) : [];
    }
    if (failure) throw failure;
    return [];
  }
  textmateTokens(document, start, end) { return this.allowed(document.uri) ? this.textmateColors.colorize(document, start, end) : Promise.resolve([]); }
  localColorTokens(document) { return this.allowed(document.uri) ? this.localCColors.colorize(document) : Promise.resolve([]); }
  dispose() { this.disposed = true; this.subscription?.dispose(); this.queries.dispose(); this.textmateColors.dispose(); this.localCColors.dispose(); this.semanticColorInflight.clear(); }
  async semanticTokens(uri, languageId) {
    if (!this.allowed(uri)) return [];
    const document = await vscode.workspace.openTextDocument(uri);
    if (!semanticColoringEnabled(document)) return [];
    const configuration = JSON.stringify(vscode.workspace.getConfiguration('editor', { uri, languageId: languageId || document.languageId }).get('semanticTokenColorCustomizations', {}));
    const cached = this.semanticColorRequests.get(document);
    if (cached?.version === document.version && cached.epoch === this.queries.epoch && cached.configuration === configuration && Date.now() - cached.created < 250) return cached.promise;
    const promise = this.requestSemanticTokens(uri, document);
    this.semanticColorRequests.set(document, { version: document.version, epoch: this.queries.epoch, configuration, created: Date.now(), promise });
    return promise;
  }
  async requestSemanticTokens(uri, document) {
    if (this.disposed) return [];
    const { semanticSpans } = require('./preview-colors');
    const epoch = this.queries.epoch, snapshot = this.semanticColorSnapshots.get(document);
    const previous = snapshot?.version === document.version && snapshot.epoch === epoch ? snapshot.spans : undefined;
    let slot = this.semanticColorInflight.get(document);
    if (slot && slot.version !== document.version || !slot && this.semanticColorInflight.size >= 4) return previous || [];
    if (!slot) {
      const version = document.version;
      const promise = Promise.all([
      /** @type {Thenable<import('vscode').SemanticTokensLegend>} */ (vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', uri)),
      /** @type {Thenable<import('vscode').SemanticTokens>} */ (vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', uri))
      ]).then(([legend, tokens]) => {
        if (this.disposed || document.isClosed || document.version !== version || this.queries.epoch !== epoch || !this.allowed(uri)) return [];
        const spans = semanticSpans(legend, tokens?.data);
        this.semanticColorSnapshots.set(document, { version, epoch, spans }); return spans;
      }).catch(() => []);
      slot = { version, promise }; this.semanticColorInflight.set(document, slot);
      promise.then(() => { if (this.semanticColorInflight.get(document) === slot) this.semanticColorInflight.delete(document); });
    }
    // A provider may finish after the display timeout. Preserve that version's
    // result for the next refresh while starting one bounded background update.
    if (previous) return previous;
    let timer;
    try { return await Promise.race([slot.promise, new Promise(resolve => { timer = setTimeout(() => resolve([]), 1500); })]); }
    finally { clearTimeout(timer); }
  }
}
module.exports = { LanguageAdapter };
