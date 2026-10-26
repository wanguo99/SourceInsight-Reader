'use strict';
const vscode = require('vscode');
const { FileLog } = require('./file-log');
const { cacheStorageDirectory, logStorageDirectory } = require('./index-storage-path');

class PersistentOutput {
  constructor(context) {
    this.context = context; this.channel = vscode.window.createOutputChannel('SourceInsight-Reader'); this.retiring = new Set(); this.writers = [];
    this.subscription = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('sourceInsightReader.cacheDirectory') || event.affectsConfiguration('sourceInsightReader.fileLoggingEnabled')) this.configure();
    });
    this.folders = vscode.workspace.onDidChangeWorkspaceFolders(() => this.configure());
    this.configure();
  }
  configure() {
    if (this.closed) return;
    const config = vscode.workspace.getConfiguration('sourceInsightReader');
    let directory;
    try { directory = config.get('fileLoggingEnabled', true) ? cacheStorageDirectory(this.context, config.get('cacheDirectory', '')) : undefined; }
    catch (error) { this.channel.appendLine(`缓存目录无效，保留原日志位置：${error.message}`); return; }
    const projects = vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) || [];
    if (!projects.length) projects.push('empty-window');
    const identity = JSON.stringify(projects);
    if (directory === this.directory && identity === this.identity && !this.writers.some(writer => writer.failed)) return;
    for (const writer of this.writers) {
      const pending = writer.dispose(); this.retiring.add(pending); pending.finally(() => this.retiring.delete(pending));
    }
    this.directory = directory; this.identity = identity;
    this.writers = directory ? projects.map(project => new FileLog(logStorageDirectory(this.context, directory, project), project, message => this.channel.appendLine(message))) : [];
    this.writer = this.writers[0];
    for (const writer of this.writers) {
      this.channel.appendLine(`文件日志：${writer.file}`); writer.appendLine(`文件日志：${writer.file}`);
    }
  }
  appendLine(message) { if (this.closed) return; this.channel.appendLine(message); for (const writer of this.writers) writer.appendLine(message); }
  async flush() { await Promise.all([...this.retiring, ...this.writers.map(writer => writer.flush())]); }
  dispose() { this.closed = true; this.subscription.dispose(); this.folders.dispose(); for (const writer of this.writers) writer.dispose(); return this.flush().finally(() => this.channel.dispose()); }
}
module.exports = { PersistentOutput };
