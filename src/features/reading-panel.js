'use strict';
const vscode = require('vscode');
const { ViewChannel } = require('../infrastructure/view-channel');
const contextActions = ['ready', 'highlightSymbol', 'navigate', 'lock', 'open', 'pin', 'fullFunction', 'refresh', 'rebuildIndex', 'mode', 'earlier', 'later', 'back', 'forward', 'candidate'];
const editorActions = { editorBack: 'workbench.action.navigateBack', editorForward: 'workbench.action.navigateForward' };
const relationActions = ['ready', 'more', 'view', 'incoming', 'outgoing', 'lock', 'refresh', 'verify', 'collapse', 'sites', 'site', 'toggle', 'select', 'open', 'references', 'root'].map(value => `relation.${value}`);
class ReadingPanel {
  constructor(extensionUri, context, relations, fail, index) {
    this.extensionUri = extensionUri; this.context = context; this.relations = relations; this.fail = fail;
    this.index = index;
    this.indexSubscription = index?.onDidChangeStatus(() => this.publishIndex());
    this.subscription = context.onDidChange(state => { this.channel?.postMessage(state); });
  }
  publishIndex() { if (this.index) this.channel?.postMessage(this.index.getStatus()); }
  get port() { return this.channel; }
  resolveWebviewView(view) {
    this.channel?.dispose(); this.closed?.dispose(); this.visibility?.dispose();
    const channel = new ViewChannel(view.webview, this.extensionUri, [...contextActions, ...relationActions, ...Object.keys(editorActions)], async message => {
      if (message.action === 'rebuildIndex') {
        await vscode.commands.executeCommand('sourceInsightReader.rebuildIndex'); return;
      }
      if (editorActions[message.action]) {
        await vscode.commands.executeCommand(editorActions[message.action]); return;
      }
      if (message.action.startsWith('relation.')) await this.relations.handleMessage(message);
      else await this.context.handleMessage(message);
      if (message.action === 'ready') { this.publishIndex(); await this.relations.publish(); }
    }, this.fail);
    this.channel = channel;
    view.webview.options = { enableScripts: true, localResourceRoots: channel.roots() };
    view.webview.html = channel.document({ title: 'Context / Relation', styles: ['media/context.css', 'media/reading-panel.css'],
      scripts: ['media/symbol-matches.js', 'media/context.js', 'media/relation-layout.js', 'media/relation.js'], body: `<section id="context-pane" aria-label="Context"><h2 class="pane-title context-heading"><span>Context</span><span id="status" role="status" aria-live="polite"></span><span id="path"></span></h2>
<header id="metadata" hidden><select id="candidates" aria-label="定义候选" hidden></select></header>
<pre id="code" tabindex="0" aria-label="只读源码预览"></pre>
<div class="context-find"><input id="context-find" type="search" aria-label="在预览中查找" placeholder="在预览中查找"><button id="find-next" type="button">下一处</button><span id="find-count" role="status" aria-live="polite"></span></div>
<nav aria-label="预览工具栏">
<span class="editor-history-label">主编辑器</span><button id="back" type="button" title="主编辑器：后退到上一阅读位置" aria-label="主编辑器位置后退">←</button>
<button id="forward" type="button" title="主编辑器：前进到下一阅读位置" aria-label="主编辑器位置前进">→</button><span class="separator" aria-hidden="true"></span>
<button id="open" type="button" title="在主编辑器打开" aria-label="在主编辑器打开">↗</button>
<button id="pin" type="button">固定到旁侧编辑器</button><button id="fullFunction" type="button">完整函数</button>
<span class="separator" aria-hidden="true"></span>
<button id="earlier" type="button" title="向上浏览" aria-label="向上浏览">↑</button><button id="later" type="button" title="向下浏览" aria-label="向下浏览">↓</button>
<span class="separator" aria-hidden="true"></span>
<button id="highlight" type="button" title="选中符号后固定 / 取消同名高亮（F2 / Ctrl+Alt+H）" aria-label="固定或取消同名符号高亮">高亮</button><button id="lock" type="button">锁定</button><button id="refresh" type="button" title="刷新" aria-label="刷新">⟳</button>
<button id="mode" type="button" title="Context 跟随模式" aria-label="Context 跟随模式">⚙</button>
<button id="rebuildIndex" type="button" title="重新扫描当前工程并重建本地索引" aria-label="重建索引">重建索引</button></nav></section>
<div id="reading-splitter" role="separator" tabindex="0" aria-label="调整 Context 和 Relation 宽度" aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="60"></div>
<section id="relation-pane" aria-label="Relation"><h2 class="pane-title relation-heading"><span>Relation</span><span id="relation-status" role="status">请选择函数</span></h2><div id="relation-tree" role="tree" tabindex="0" aria-label="调用关系"></div>
<div id="relation-index-status" role="status" aria-live="polite" hidden></div>
<nav aria-label="Relation 工具栏"><button id="relation-view" type="button" title="选择横向关系图或树形列表" aria-label="选择 Relation 显示方式">视图</button><button id="relation-incoming" type="button">谁调用它</button><button id="relation-outgoing" type="button">它调用谁</button>
<button id="relation-collapse" type="button">折叠</button><button id="relation-open" type="button" title="在主编辑器打开" aria-label="在主编辑器打开">↗</button>
<button id="relation-references" type="button">引用</button><button id="relation-root" type="button">设为根</button>
<button id="relation-more" type="button" hidden>继续显示关系</button>
<button id="relation-verify" type="button" title="用语言服务重新查询当前函数的两个方向；查询失败保留已有结果" aria-label="语言服务复查">复查</button><button id="relation-lock" type="button">锁定</button><button id="relation-refresh" type="button" title="刷新" aria-label="刷新">⟳</button></nav></section>
` });
    this.closed = view.onDidDispose(() => { if (this.channel === channel) { channel.dispose(); this.channel = undefined; } });
    this.visibility = view.onDidChangeVisibility(() => { if (view.visible) { this.context.publish(); this.relations.publish().catch(this.fail); } });
    this.publishIndex(); this.context.publish(); this.relations.publish().catch(this.fail);
  }
  dispose() { this.channel?.dispose(); this.closed?.dispose(); this.visibility?.dispose(); this.subscription.dispose(); this.indexSubscription?.dispose(); }
}
module.exports = { ReadingPanel };
