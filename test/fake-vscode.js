'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

class Disposable { constructor(fn = () => {}) { this.fn = fn; } dispose() { this.fn(); } }
class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = listener => { this.listeners.add(listener); return new Disposable(() => this.listeners.delete(listener)); }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isEqual(other) { return this.line === other.line && this.character === other.character; }
}
class Range {
  constructor(a, b, c, d) {
    this.start = typeof a === 'number' ? new Position(a, b) : a;
    this.end = typeof a === 'number' ? new Position(c, d) : b;
  }
}
class Selection extends Range {
  constructor(a, b, c, d) { super(a, b, c, d); this.active = this.end; this.anchor = this.start; }
}
class Uri {
  constructor(value) { this.value = value; this.path = decodeURIComponent(new URL(value).pathname); this.scheme = new URL(value).protocol.slice(0, -1); this.authority = new URL(value).host; this.fsPath = this.path; }
  toString() { return this.value; }
  static file(value) { return new Uri(`file://${value}`); }
  static parse(value) { return new Uri(value); }
  static joinPath(uri, ...parts) { return new Uri(`${uri.scheme}://${uri.authority}${path.posix.join(uri.path, ...parts)}`); }
}
class Document {
  constructor(uri, text) { this.uri = uri; this.text = text; this.version = 1; this.isDirty = false; this.isClosed = false; this.languageId = 'cpp'; }
  get lineCount() { return this.text.split('\n').length; }
  lineAt(line) { return { text: this.text.split('\n')[line] }; }
  validateRange(range) {
    const clamp = point => {
      const line = Math.min(point.line, this.lineCount - 1);
      return new Position(line, Math.min(point.character, this.lineAt(line).text.length));
    };
    return new Range(clamp(range.start), clamp(range.end));
  }
  getWordRangeAtPosition(position) {
    const text = this.lineAt(position.line).text;
    for (const match of text.matchAll(/\w+/g)) if (match.index <= position.character && position.character <= match.index + match[0].length)
      return new Range(position.line, match.index, position.line, match.index + match[0].length);
  }
  getText(range) { return range ? this.lineAt(range.start.line).text.slice(range.start.character, range.end.character) : this.text; }
}

function fakeVscode() {
  const events = {};
  for (const name of ['active', 'selection', 'document', 'folders', 'configuration', 'create', 'delete', 'change']) events[name] = new EventEmitter();
  const documents = new Map();
  const commands = new Map();
  const views = new Map();
  const quicks = [];
  const settings = new Map([['sourceReader.autoPreview', false], ['sourceReader.autoRelation', false], ['sourceReader.files.exclude', ['**/.git', '**/node_modules']]]);
  const api = {
    EventEmitter, Position, Range, Selection, Uri, Disposable,
    TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    ViewColumn: { One: 1 }, ConfigurationTarget: { Workspace: 2 },
    commands: {
      registerCommand(name, handler) { commands.set(name, handler); return new Disposable(() => commands.delete(name)); },
      async executeCommand(name, ...args) { return commands.get(name)?.(...args); }
    },
    workspace: {
      workspaceFolders: [{ uri: Uri.file('/project'), name: 'project' }],
      getConfiguration(section) { return {
        get(key, fallback) { return settings.has(`${section}.${key}`) ? settings.get(`${section}.${key}`) : fallback; },
        async update(key, value) { settings.set(`${section}.${key}`, value); }
      }; },
      fs: { async readDirectory() { return []; } },
      asRelativePath(uri) { return uri.path.replace(/^\/project\//, ''); },
      async openTextDocument(uri) { const document = documents.get(uri.toString()); if (!document) throw new Error('File not found'); return document; },
      onDidChangeTextDocument: events.document.event,
      onDidChangeWorkspaceFolders: events.folders.event,
      onDidChangeConfiguration: events.configuration.event,
      createFileSystemWatcher() { return { dispose() {}, onDidCreate: events.create.event, onDidDelete: events.delete.event, onDidChange: events.change.event }; }
    },
    window: {
      activeTextEditor: undefined,
      createOutputChannel() { return { appendLine() {}, dispose() {} }; },
      createQuickPick() {
        const change = new EventEmitter(), active = new EventEmitter(), accept = new EventEmitter(), hide = new EventEmitter();
        let value = '';
        const picker = { items: [], selectedItems: [], disposed: false,
          get value() { return value; }, set value(text) { value = text; change.fire(text); },
          onDidChangeValue: change.event, onDidChangeActive: active.event, onDidAccept: accept.event, onDidHide: hide.event,
          show() {}, hide() { hide.fire(); }, dispose() { this.disposed = true; },
          activate(index) { active.fire([picker.items[index]]); },
          accept(index) { picker.selectedItems = [picker.items[index]]; accept.fire(); }
        };
        quicks.push(picker); return picker;
      },
      createTreeView(id, options) {
        const selection = new EventEmitter();
        const visibility = new EventEmitter();
        const view = { visible: false, selection: [], onDidChangeSelection: selection.event, onDidChangeVisibility: visibility.event,
          dispose() { selection.dispose(); visibility.dispose(); },
          async reveal(node, options) { if (options.select) { view.selection = [node]; selection.fire({ selection: [node] }); } },
          select(node) { view.selection = [node]; selection.fire({ selection: [node] }); },
          treeDataProvider: options.treeDataProvider };
        views.set(id, view); return view;
      },
      registerWebviewViewProvider() { return new Disposable(); },
      onDidChangeActiveTextEditor: events.active.event,
      onDidChangeTextEditorSelection: events.selection.event,
      async showTextDocument(document, options = {}) {
        const range = options.selection || new Range(0, 0, 0, 0);
        const editor = { document, selection: new Selection(range.start, range.end), viewColumn: 1 };
        api.window.activeTextEditor = editor; events.active.fire(editor); return editor;
      },
      async showQuickPick(choices) { return choices[0]; },
      async showInputBox() { return undefined; },
      showErrorMessage(message) { throw new Error(message); }
    }
  };
  return { api, documents, commands, settings, events, views, quicks,
    document(name, text = 'int first() { return 1; }\nint second() { return first(); }\n') {
      const document = new Document(Uri.file(`/project/${name}`), text);
      documents.set(document.uri.toString(), document); return document;
    },
    context: { extensionUri: Uri.file('/extension'), subscriptions: [], workspaceState: { get(key, fallback) { return fallback; }, async update() {} } }
  };
}

function loadWithVscode(file, vscode, cache = new Map()) {
  const filename = require.resolve(file);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const nativeRequire = createRequire(filename);
  const injectedRequire = id => id === 'vscode' ? vscode : id.startsWith('.')
    ? loadWithVscode(nativeRequire.resolve(id), vscode, cache) : nativeRequire(id);
  const wrapper = vm.runInThisContext(`(function(require, module, exports, __filename, __dirname) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  wrapper(injectedRequire, module, module.exports, filename, path.dirname(filename));
  return module.exports;
}

module.exports = { fakeVscode, loadWithVscode };
