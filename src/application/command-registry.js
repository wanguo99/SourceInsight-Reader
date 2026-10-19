'use strict';
const vscode = require('vscode');
class CommandRegistry {
  constructor(disposables, run) { this.disposables = disposables; this.run = run; }
  add(name, action) { this.disposables.push(vscode.commands.registerCommand(`sourceInsightInspired.${name}`, (...args) => this.run(() => action(...args), true))); }
}
module.exports = { CommandRegistry };
