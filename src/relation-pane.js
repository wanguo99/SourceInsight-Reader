'use strict';
const vscode = require('vscode');
const { RequestGate, locationKey } = require('./core');

// Adapter for the existing semantic relation model, rendered alongside Context in one webview.
class RelationPane {
  constructor(model, webview, open, fail) {
    this.model = model; this.webview = webview; this.open = open; this.fail = fail;
    this.selection = []; this.expanded = new Set(); this.targets = new Map(); this.gate = new RequestGate();
    this.emitter = new vscode.EventEmitter(); this.onDidChangeSelection = this.emitter.event;
    this.subscription = model.onDidChangeTreeData(() => this.publish().catch(fail));
    this._description = ''; this.serial = 0;
  }
  set description(value) { this._description = value; this.publish().catch(this.fail); }
  get description() { return this._description; }
  viewMode() { return vscode.workspace.getConfiguration('sourceInsightInspired').get('relationView', String('horizontalGraph')); }
  async focus() {
    await this.publish();
    await this.webview()?.postMessage({ scope: 'relation', focus: true });
  }
  async handleMessage(message) {
    const action = message.action.slice('relation.'.length);
    if (action === 'ready') return this.publish();
    if (action === 'view') return vscode.commands.executeCommand('sourceInsightInspired.chooseRelationView');
    const commands = { incoming: 'incoming', outgoing: 'outgoing', lock: 'toggleRelationLock', refresh: 'refreshRelations' };
    if (commands[action]) return vscode.commands.executeCommand(`sourceInsightInspired.${commands[action]}`);
    if (action === 'collapse') { this.expanded.clear(); return this.publish(); }
    const entry = this.targets.get(message.id);
    if (!entry) return;
    const { node, key } = entry;
    if (action === 'sites') {
      if (!node.sites?.length) return;
      /** @type {Array<import('vscode').QuickPickItem & {site: any}>} */
      const choices = node.sites.map((site, index) => ({ label: `调用位置 ${index + 1}`,
        description: `${vscode.workspace.asRelativePath(site.uri)}:${site.range.start.line + 1}:${site.range.start.character + 1}`,
        site }));
      const choice = await vscode.window.showQuickPick(choices, { placeHolder: `${node.name} 的调用位置` });
      if (!choice || this.targets.get(message.id) !== entry) return;
      const target = { type: 'callsite', ...choice.site, name: node.name };
      this.selection = [node]; this.selectedKey = key;
      this.emitter.fire({ selection: [target] });
      return;
    }
    if (action === 'toggle') {
      if (!['relation', 'sites'].includes(node.type)) return;
      if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
      return this.publish();
    }
    if (!node.uri) return;
    this.selection = [node]; this.selectedKey = key;
    if (action === 'select') {
      // Preview the edge's call site while retaining the function node for
      // explicit open/root actions. Calls with multiple sites use the first.
      const site = node.type === 'relation' ? node.sites?.[0] : undefined;
      const preview = site ? { type: 'callsite', ...site, name: node.name } : node;
      this.emitter.fire({ selection: [preview] });
      await this.webview()?.postMessage({ scope: 'relation', selectionOnly: true, selectedId: message.id });
      return;
    }
    if (action === 'open') await this.open(node);
    if (action === 'references') await vscode.commands.executeCommand('sourceInsightInspired.lookupReferences', node);
    if (action === 'root') await vscode.commands.executeCommand('sourceInsightInspired.setRoot', node);
    await this.publish();
  }
  async publish() {
    const webview = this.webview(); if (!webview) return;
    const request = this.gate.next(), modelVersion = this.model.gate.version;
    this.targets = new Map();
    const mode = this.viewMode();
    if (this.root !== this.model.root || this.direction !== this.model.direction || this.wasStale !== this.model.stale || this.mode !== mode) {
      this.mode = mode;
      this.root = this.model.root; this.direction = this.model.direction; this.wasStale = this.model.stale;
      this.expanded.clear(); this.selectedKey = undefined; this.selection = [];
      if (this.root) this.expanded.add(`root/${locationKey(this.root)}`);
    }
    if (mode === 'horizontalGraph') return this.publishGraph(webview, request, modelVersion);
    const targets = new Map(); let count = 0, truncated = false;
    const render = async (node, parent, depth) => {
      if (++count > 500 || depth > 40) { truncated = true; return undefined; }
      const key = `${parent}/${node.uri ? locationKey(node) : node.type}`;
      const id = String(++this.serial); targets.set(id, { node, key });
      const expandable = ['relation', 'sites'].includes(node.type), expanded = expandable && this.expanded.has(key);
      const row = { id, type: node.type, expanded, expandable, selected: key === this.selectedKey,
        label: node.type === 'sites' ? `调用位置（${node.sites.length}）` : node.label || `${node.cycle ? '↻ ' : ''}${node.name || ''}`,
        description: node.uri ? `${vscode.workspace.asRelativePath(node.uri)}:${node.range.start.line + 1}${node.item?.sourceInsightInspiredLocal ? node.item.sourceInsightInspiredLocal.unresolved ? ' · 未解析，调用现场' : ' · C 语法' : ''}` : '', children: [] };
      if (expanded) {
        for (const child of await this.model.getChildren(node)) {
          if (!this.gate.current(request) || !this.model.gate.current(modelVersion)) return undefined;
          const value = await render(child, key, depth + 1);
          if (value) row.children.push(value); else break;
        }
      }
      return row;
    };
    const rows = [];
    for (const root of await this.model.getChildren()) {
      const value = await render(root, 'root', 0); if (value) rows.push(value);
    }
    if (!this.gate.current(request) || !this.model.gate.current(modelVersion)) return;
    this.targets = targets;
    const selectedId = [...targets.entries()].find(([, value]) => value.key === this.selectedKey)?.[0];
    if (!selectedId) { this.selection = []; this.selectedKey = undefined; }
    await webview.postMessage({ scope: 'relation', viewMode: 'outline', rows, description: this._description,
      direction: this.model.direction, locked: this.model.locked, stale: this.model.stale,
      truncated, selectedId });
  }
  async publishGraph(webview, request, modelVersion) {
    const root = this.model.root;
    const [incoming, outgoing] = root ? await Promise.all([
      this.model.getChildren(root, 'incoming'), this.model.getChildren(root, 'outgoing')
    ]) : [[], []];
    if (!this.gate.current(request) || !this.model.gate.current(modelVersion)) return;
    const targets = new Map();
    const row = (node, column) => {
      const key = `${column}/${node.uri ? locationKey(node) : node.type}`;
      const id = String(++this.serial);
      targets.set(id, { node, key });
      return { id, type: node.type, label: node.label || `${node.cycle ? '↻ ' : ''}${node.name || ''}`,
        description: node.uri ? `${vscode.workspace.asRelativePath(node.uri)}:${node.range.start.line + 1}` : '',
        detail: node.item?.detail || '', siteCount: node.sites?.length || 0,
        selected: key === this.selectedKey, unresolved: Boolean(node.item?.sourceInsightInspiredLocal?.unresolved) };
    };
    // Only root-adjacent functions are queried, never grandchildren. Bound the
    // DOM independently of project size; exact call sites remain in the model.
    const limit = 200;
    const graph = { root: root ? row(root, 'root') : undefined,
      incoming: incoming.slice(0, limit).map(node => row(node, 'incoming')),
      outgoing: outgoing.slice(0, limit).map(node => row(node, 'outgoing')),
      incomingCount: incoming.filter(node => node.type === 'relation').length,
      outgoingCount: outgoing.filter(node => node.type === 'relation').length,
      message: this.model.message };
    this.targets = targets;
    const selectedId = [...targets.entries()].find(([, entry]) => entry.key === this.selectedKey)?.[0];
    if (!selectedId) { this.selection = []; this.selectedKey = undefined; }
    await webview.postMessage({ scope: 'relation', viewMode: 'horizontalGraph', rows: [], graph,
      description: `双向一层${root?.item.sourceInsightInspiredLocal ? ' · 本地 C 索引' : ''}${this.model.stale ? ' · 可能过期，请刷新' : ''}`,
      locked: this.model.locked, stale: this.model.stale, selectedId,
      truncated: incoming.length > limit || outgoing.length > limit });
  }
  dispose() { this.gate.dispose(); this.subscription.dispose(); this.emitter.dispose(); this.targets.clear(); }
}
module.exports = { RelationPane };
