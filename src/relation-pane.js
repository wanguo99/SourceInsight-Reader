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
  async focus() {
    await this.publish();
    await this.webview()?.postMessage({ scope: 'relation', focus: true });
  }
  async handleMessage(message) {
    const action = message.action.slice('relation.'.length);
    if (action === 'ready') return this.publish();
    const commands = { incoming: 'incoming', outgoing: 'outgoing', lock: 'toggleRelationLock', refresh: 'refreshRelations' };
    if (commands[action]) return vscode.commands.executeCommand(`sourceReader.${commands[action]}`);
    if (action === 'collapse') { this.expanded.clear(); return this.publish(); }
    const entry = this.targets.get(message.id);
    if (!entry) return;
    const { node, key } = entry;
    if (action === 'toggle') {
      if (!['relation', 'sites'].includes(node.type)) return;
      if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
      return this.publish();
    }
    if (!node.uri) return;
    this.selection = [node]; this.selectedKey = key;
    if (action === 'select') {
      this.emitter.fire({ selection: [node] });
      await this.webview()?.postMessage({ scope: 'relation', selectionOnly: true, selectedId: message.id });
      return;
    }
    if (action === 'open') await this.open(node);
    if (action === 'references') await vscode.commands.executeCommand('sourceReader.lookupReferences', node);
    if (action === 'root') await vscode.commands.executeCommand('sourceReader.setRoot', node);
    await this.publish();
  }
  async publish() {
    const webview = this.webview(); if (!webview) return;
    const request = this.gate.next(), modelVersion = this.model.gate.version;
    this.targets = new Map();
    if (this.root !== this.model.root || this.direction !== this.model.direction || this.wasStale !== this.model.stale) {
      this.root = this.model.root; this.direction = this.model.direction; this.wasStale = this.model.stale;
      this.expanded.clear(); this.selectedKey = undefined; this.selection = [];
      if (this.root) this.expanded.add(`root/${locationKey(this.root)}`);
    }
    const targets = new Map(); let count = 0, truncated = false;
    const render = async (node, parent, depth) => {
      if (++count > 500 || depth > 40) { truncated = true; return undefined; }
      const key = `${parent}/${node.uri ? locationKey(node) : node.type}`;
      const id = String(++this.serial); targets.set(id, { node, key });
      const expandable = ['relation', 'sites'].includes(node.type), expanded = expandable && this.expanded.has(key);
      const row = { id, type: node.type, expanded, expandable, selected: key === this.selectedKey,
        label: node.type === 'sites' ? `调用位置（${node.sites.length}）` : node.label || `${node.cycle ? '↻ ' : ''}${node.name || ''}`,
        description: node.uri ? `${vscode.workspace.asRelativePath(node.uri)}:${node.range.start.line + 1}` : '', children: [] };
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
    await webview.postMessage({ scope: 'relation', rows, description: this._description,
      direction: this.model.direction, locked: this.model.locked, stale: this.model.stale,
      truncated, selectedId });
  }
  dispose() { this.gate.dispose(); this.subscription.dispose(); this.emitter.dispose(); this.targets.clear(); }
}
module.exports = { RelationPane };
