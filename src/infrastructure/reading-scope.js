'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { uriKey, relativeUriPath } = require('../resources');
const KEYS = ['sourceInsightReader.excludedDirectories', 'sourceInsightReader.excludedFiles'];
function changed(event) { return KEYS.some(key => event.affectsConfiguration(key)); }
function compact(roots) {
  const unique = [...new Map(roots.map(root => [uriKey(root.uri), root])).values()];
  return unique.filter(root => !unique.some(other => other !== root && relativeUriPath(other.uri, root.uri) !== undefined));
}
class ReadingScope {
  constructor() { this.cachedKey = ''; this.cached = undefined; }
  workspaceRoots() { return vscode.workspace.workspaceFolders || []; }
  settings(key) { return vscode.workspace.getConfiguration('sourceInsightReader').get(key, []); }
  restricted() { return Boolean(this.settings('excludedDirectories').length || this.settings('excludedFiles').length); }
  resolve(values, mergeDirectories = true) {
    const folders = this.workspaceRoots(), result = [];
    for (const input of values) {
      if (typeof input !== 'string' || !input.trim()) throw new Error('检索 / 屏蔽目录必须是非空路径');
      const value = input.trim().replace(/\\/g, '/'); let candidates;
      if (/^[a-z][\w+.-]*:\/\//i.test(value)) candidates = [vscode.Uri.parse(value)];
      else if (/^[a-z]:\//i.test(value) || value.startsWith('//')) candidates = [vscode.Uri.file(input.trim())];
      else if (value.startsWith('/')) candidates = folders.map(folder => folder.uri.with({ path: path.posix.normalize(value) }));
      else {
        const named = folders.length > 1 ? folders.find(folder => value === folder.name || value.startsWith(folder.name + '/')) : undefined;
        const bases = named ? [named] : folders;
        const relative = named ? value.slice(named.name.length).replace(/^\//, '') : value;
        candidates = bases.map(folder => vscode.Uri.joinPath(folder.uri, relative || '.'));
      }
      const inside = candidates.filter(uri => folders.some(folder => relativeUriPath(folder.uri, uri) !== undefined));
      if (!inside.length) throw new Error(`目录不在已打开工作区内：${input}。请先将外部目录添加到工作区。`);
      for (const uri of inside) {
        const base = [...folders].sort((a, b) => b.uri.path.length - a.uri.path.length).find(folder => relativeUriPath(folder.uri, uri) !== undefined);
        const relative = relativeUriPath(base.uri, uri);
        result.push({ uri, name: folders.length > 1 ? base.name + (relative ? '/' + relative : '') : relative || base.name, index: result.length });
      }
    }
    return mergeDirectories ? compact(result) : [...new Map(result.map(value => [uriKey(value.uri), value])).values()];
  }
  description() {
    try {
      const excludes = [...this.settings('excludedDirectories'), ...this.settings('excludedFiles')];
      return `检索：整个工作区${excludes.length ? ' · 屏蔽：' + excludes.join('、') : ''}`;
    } catch (error) { return error.message; }
  }
  snapshot() {
    const excludedValues = this.settings('excludedDirectories');
    const fileValues = this.settings('excludedFiles');
    const key = JSON.stringify([excludedValues, fileValues, this.workspaceRoots().map(root => [root.name, uriKey(root.uri)])]);
    if (this.cachedKey === key) return this.cached;
    let result;
    try {
      const excludes = this.resolve(excludedValues);
      const roots = this.workspaceRoots().filter(root =>
        !excludes.some(excluded => relativeUriPath(excluded.uri, root.uri) !== undefined));
      const files = this.resolve(fileValues, false);
      result = { roots, excludes, files, fileKeys: new Set(files.map(file => uriKey(file.uri))), error: undefined };
    } catch (error) { result = { roots: [], excludes: [], files: [], fileKeys: new Set(), error: error.message }; }
    this.cachedKey = key; this.cached = result; return result;
  }
  roots() { return this.snapshot().roots; }
  key(snapshot = this.snapshot()) {
    if (snapshot.fingerprint) return snapshot.fingerprint;
    const { roots, excludes, files, error } = snapshot;
    return snapshot.fingerprint = createHash('sha256').update(JSON.stringify([roots.map(root => uriKey(root.uri)).sort(),
      excludes.map(root => uriKey(root.uri)).sort(), files.map(root => uriKey(root.uri)).sort(), error || ''])).digest('hex');
  }
  contains(uri, snapshot = this.snapshot()) {
    const { roots, excludes, fileKeys } = snapshot;
    return roots.some(root => relativeUriPath(root.uri, uri) !== undefined) &&
      !excludes.some(root => relativeUriPath(root.uri, uri) !== undefined) && !fileKeys.has(uriKey(uri));
  }
  accepts(uri) {
    const snapshot = this.snapshot();
    if (snapshot.error) return false;
    // Excluding workspace files must not implicitly exclude the external SDK.
    const inWorkspace = this.workspaceRoots().some(root => relativeUriPath(root.uri, uri) !== undefined);
    return inWorkspace ? this.contains(uri, snapshot) : true;
  }
  excludePattern(root, existing) {
    const patterns = existing ? [existing] : [];
    for (const excluded of this.snapshot().excludes) {
      const relative = relativeUriPath(root.uri, excluded.uri);
      if (relative) {
        // Escape literal glob characters in explicitly selected directory names.
        const literal = relative.replace(/[\[\]*?{},]/g, char => char === '[' ? '[[]' : char === ']' ? '[]]' : '[' + char + ']');
        patterns.push(literal + '/**');
      }
    }
    for (const file of this.snapshot().files) {
      const relative = relativeUriPath(root.uri, file.uri);
      if (relative) patterns.push(relative.replace(/[\[\]*?{},]/g, char => char === '[' ? '[[]' : char === ']' ? '[]]' : '[' + char + ']'));
    }
    return patterns.length > 1 ? '{' + patterns.join(',') + '}' : patterns[0];
  }
}
module.exports = { ReadingScope, scopeConfigurationChanged: changed };
