'use strict';
const vscode = require('vscode');
const { RequestGate } = require('./core');
const messages = {
  idle: '请选择函数', loading: '正在查询…', refreshing: '正在刷新，显示上次结果', stale: '源码已变化，请刷新；旧位置不可跳转',
  empty: '未找到直接调用', failed: '查询未完成', retained: '查询未完成，保留上次结果'
};
const range = value => new vscode.Range(value.start.line, value.start.character, value.end.line, value.end.character);
function description(state) {
  if (state.status === 'failed' && state.result?.status === 'notFound') return ['当前位置未找到可查询调用关系的函数；请将光标移到函数定义、调用处或函数体内',
    ...(state.result.diagnostics || []).filter(note => !/^本地 C 索引[：:]?/.test(note))].join('；');
  return [messages[state.status] || '', state.dataStale && state.status !== 'stale' ? '旧位置不可跳转' : '', ...(state.result?.diagnostics || [])].filter(Boolean).join('；'); }
class RelationPane {
  constructor(model, outlet, open, fail) {
    this.model = model; this.outlet = outlet; this.open = open; this.fail = fail;
    this.selection = []; this.expanded = new Set(); this.targets = new Map(); this.ids = new Map(); this.gate = new RequestGate(); this.serial = 0;
    this.graphLimit = 200; this.outlineLimit = 500; this.depthLimit = 40;
    this.emitter = new vscode.EventEmitter(); this.onDidChangeSelection = this.emitter.event;
    this.subscription = model.onDidChange(() => {
      if (this.publishQueued || this.disposed) return;
      this.publishQueued = true;
      Promise.resolve().then(() => {
        this.publishQueued = false;
        if (!this.disposed) this.publish().catch(fail);
      });
    });
  }
  isStale() {
    const root = this.model.root;
    const directions = this.viewMode() === 'horizontalGraph' ? ['incoming', 'outgoing'] : [this.model.direction];
    const states = [this.model.rootState, ...(root ? directions.map(direction => this.model.edgeState(root, direction)) : [])];
    return states.some(value => value.status === 'stale' || value.dataStale);
  }
  viewMode() { return vscode.workspace.getConfiguration('sourceInsightReader').get('relationView', 'horizontalGraph'); }
  node(symbol, sites = [], ancestors = []) {
    return { type: 'relation', symbol, uri: vscode.Uri.parse(symbol.location.uri), range: range(symbol.location.range), name: symbol.name,
      sites: sites.map(site => ({ uri: vscode.Uri.parse(site.uri), range: range(site.range) })), ancestors: [...ancestors, symbol.id], cycle: ancestors.includes(symbol.id) };
  }
  children(node, direction) {
    if (node.cycle) return [{ type: 'message', label: '↻ 递归关系：停止展开' }];
    if (node.symbol.unresolved) return [{ type: 'message', label: node.symbol.detail || '未解析目标' }];
    const current = this.model.edgeState(node.symbol, direction);
    const nodes = current.data.map(edge => ({ ...this.node(edge.symbol, edge.sites, node.ancestors), stale: Boolean(current.dataStale) }));
    return current.status === 'ready' || nodes.length ? nodes : [...nodes, { type: 'message', label: description(current) }];
  }
  async focus() { await this.publish(); await this.outlet()?.postMessage({ scope: 'relation', focus: true }); }
  async handleMessage(message) {
    const action = message.action.slice('relation.'.length);
    if (action === 'ready') { this.lastPayload = undefined; return this.publish(); }
    const commands = { view: 'chooseRelationView', incoming: 'incoming', outgoing: 'outgoing', lock: 'toggleRelationLock', refresh: 'refreshRelations', verify: 'verifyRelations' };
    if (commands[action]) return vscode.commands.executeCommand(`sourceInsightReader.${commands[action]}`);
    if (action === 'more') { this.graphLimit += 200; this.outlineLimit += 500; this.depthLimit = Math.min(200, this.depthLimit + 40); return this.publish(); }
    if (action === 'collapse') { this.expanded.clear(); return this.publish(); }
    if (this.isStale()) return;
    const entry = this.targets.get(message.id); if (!entry) return;
    const { node, key } = entry;
    if (node.stale) return;
    if (action === 'toggle') { if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key); return this.publish(); }
    if (action === 'site') {
      if (!Number.isInteger(message.index) || !node.sites?.[message.index]) return;
      this.selection = [node]; this.selectedKey = key;
      this.emitter.fire({ selection: [{ type: 'callsite', ...node.sites[message.index], name: node.name }] });
      await this.outlet()?.postMessage({ scope: 'relation', selectionOnly: true, selectedId: message.id }); return;
    }
    if (action === 'sites') {
      if (!node.sites?.length) return;
      /** @type {Array<{label:string,description:string,site:any}>} */
      const choices = node.sites.map((site, index) => ({ label: `调用位置 ${index + 1}`, description: `${vscode.workspace.asRelativePath(site.uri)}:${site.range.start.line + 1}`, site }));
      const choice = await vscode.window.showQuickPick(choices, { placeHolder: `${node.name} 的调用位置` });
      if (choice && this.targets.get(message.id) === entry) this.emitter.fire({ selection: [{ type: 'callsite', ...choice.site, name: node.name }] }); return;
    }
    if (!node.uri) return;
    this.selection = [node]; this.selectedKey = key;
    if (action === 'select') {
      this.emitter.fire({ selection: [node.sites?.length ? { type: 'callsite', ...node.sites[0], name: node.name } : node] });
      await this.outlet()?.postMessage({ scope: 'relation', selectionOnly: true, selectedId: message.id }); return;
    }
    if (action === 'open') await this.open(node);
    if (action === 'references') await vscode.commands.executeCommand('sourceInsightReader.lookupReferences', node);
    if (action === 'root') await vscode.commands.executeCommand('sourceInsightReader.setRoot', node);
  }
  async publish() {
    const webview = this.outlet(); if (!webview) return;
    const request = this.gate.next(), root = this.model.root, mode = this.viewMode(); this.model.graphMode = mode === 'horizontalGraph';
    if (this.rootId !== root?.id || this.mode !== mode) { this.targets.clear(); this.ids.clear(); this.expanded.clear(); this.selectedKey = undefined; this.selection = []; this.rootId = root?.id; this.mode = mode; if (root) this.expanded.add(`root/${root.id}`); }
    const targets = new Map();
    const row = (node, column) => {
      const key = `${column}/${node.symbol?.id || node.key || node.type}`;
      if (!this.ids.has(key)) this.ids.set(key, String(++this.serial));
      const id = this.ids.get(key); targets.set(id, { node, key });
      return { id, type: node.type, label: node.label || `${node.cycle ? '↻ ' : ''}${node.name || ''}`, key,
        description: node.uri ? `${vscode.workspace.asRelativePath(node.uri)}:${node.range.start.line + 1}` : '',
        detail: node.symbol?.detail || '', unresolved: Boolean(node.symbol?.unresolved), siteCount: node.sites?.length || 0, siteLines: (node.sites || []).slice(0, 3).map(site => ({ line: site.range.start.line + 1, file: vscode.workspace.asRelativePath(site.uri) })), selected: key === this.selectedKey };
    };
    const rootNode = root && this.node(root), status = this.model.rootState;
    const provider = value => ({ state: value.status, backend: value.result?.provider || 'none', loading: ['loading', 'refreshing'].includes(value.status), note: description(value) });
    let payload;
    if (mode === 'horizontalGraph') {
      const incoming = root ? this.children(rootNode, 'incoming') : [], outgoing = root ? this.children(rootNode, 'outgoing') : [];
      payload = { graph: { root: root && row(rootNode, 'root'), incoming: incoming.slice(0, this.graphLimit).map(node => row(node, 'incoming')),
        outgoing: outgoing.slice(0, this.graphLimit).map(node => row(node, 'outgoing')), incomingCount: incoming.filter(node => node.symbol).length,
        outgoingCount: outgoing.filter(node => node.symbol).length, message: description(status),
        incomingStatus: root && provider(this.model.edgeState(root, 'incoming')), outgoingStatus: root && provider(this.model.edgeState(root, 'outgoing')) },
        rows: [], truncated: incoming.length > this.graphLimit || outgoing.length > this.graphLimit };
    } else {
      let count = 0, truncated = false;
      const render = (node, parent, depth) => {
        if (++count > this.outlineLimit || depth > this.depthLimit) { truncated = true; return undefined; }
        const value = row(node, parent), expandable = node.type === 'relation' && !node.cycle;
        const expanded = expandable && this.expanded.has(value.key); value.expandable = expandable; value.expanded = expanded; value.children = [];
        if (expanded) {
          if (status.status !== 'stale' && !node.symbol.unresolved) this.model.load(node.symbol, this.model.direction).catch(this.fail);
          value.children = this.children(node, this.model.direction).map(child => render(child, value.key, depth + 1)).filter(Boolean);
          if (node.sites.length) {
            const sites = row({ type: 'sites', label: `调用位置（${node.sites.length}）`, sites: node.sites }, value.key);
            sites.expandable = true; sites.expanded = this.expanded.has(sites.key);
            sites.children = sites.expanded ? node.sites.map((site, index) => ({
              ...row({ type: 'callsite', ...site, name: node.name, key: String(index), label: `调用位置 ${index + 1}` }, sites.key),
              expandable: false, expanded: false, children: []
            })) : [];
            value.children.unshift(sites);
          }
        }
        return value;
      };
      payload = { rows: root ? [render(rootNode, 'root', 0)] : [{ type: 'message', label: description(status), children: [] }], truncated };
    }
    if (!this.gate.current(request)) return;
    this.targets = targets;
    this.ids = new Map([...targets].map(([id, entry]) => [entry.key, id]));
    const selectedId = [...targets.entries()].find(([, entry]) => entry.key === this.selectedKey)?.[0];
    const message = { scope: 'relation', viewMode: mode, ...payload, selectedId, direction: this.model.direction,
      description: `${mode === 'horizontalGraph' ? '双向一层' : this.model.direction === 'incoming' ? '谁调用它' : '它调用谁'} · ${description(status) || (status.result?.provider === 'local' ? '本地 C 索引' : '语言服务')}`,
      stale: this.isStale(), locked: this.model.locked };
    const signature = JSON.stringify(message);
    if (this.lastWebview !== webview || signature !== this.lastPayload) {
      this.lastWebview = webview; this.lastPayload = signature;
      await webview.postMessage(message);
    }
    await this.model.ensureRootEdges();
  }
  dispose() { this.disposed = true; this.gate.dispose(); this.subscription.dispose(); this.emitter.dispose(); this.targets.clear(); }
}
module.exports = { RelationPane };
