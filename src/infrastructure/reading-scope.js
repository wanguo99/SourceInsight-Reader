'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { uriKey, relativeUriPath } = require('../resources');
const { projectSourceSelected } = require('./project-source-selection');
const KEYS = ['sourceInsightReader.projectSources', 'sourceInsightReader.excludedDirectories', 'sourceInsightReader.excludedFiles'];
function changed(event) { return KEYS.some(key => event.affectsConfiguration(key)); }
function compact(roots) {
  const unique = [...new Map(roots.map(root => [uriKey(root.uri), root])).values()];
  return unique.filter(root => !unique.some(other => other !== root && relativeUriPath(other.uri, root.uri) !== undefined));
}
class ReadingScope {
  constructor() { this.cachedKey = ''; this.cached = undefined; /** @type {any} */ this.compilation = undefined; }
  workspaceRoots() { return vscode.workspace.workspaceFolders || []; }
  settings(key) { return vscode.workspace.getConfiguration('sourceInsightReader').get(key, []); }
  /** @returns {{mode:string, directories:string[], files:string[], compilationDatabase?:string, excludedDirectories?:string[], excludedFiles?:string[], pathMappings?:{from:string,to:string}[]}} */
  selection() { return vscode.workspace.getConfiguration('sourceInsightReader').get('projectSources', { mode: 'selected', directories: [], files: [] }); }
  restricted() { const snapshot = this.snapshot(); return Boolean(snapshot.error || snapshot.selected || snapshot.excludes.length || snapshot.files.length); }
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
      const selected = this.selection();
      return `检索：${selected.mode === 'workspace' ? '整个工作区' : selected.mode === 'compilation' ? 'compile_commands.json' : `已导入 ${selected.directories.length} 个目录、${selected.files.length} 个文件`}${excludes.length ? ' · 屏蔽：' + excludes.join('、') : ''}`;
    } catch (error) { return error.message; }
  }
  snapshot() {
    const excludedValues = this.settings('excludedDirectories');
    const fileValues = this.settings('excludedFiles');
    const selection = this.selection();
    const key = JSON.stringify([selection, this.compilation?.fingerprint, this.compilation?.selectionKey, excludedValues, fileValues, this.workspaceRoots().map(root => [root.name, uriKey(root.uri)])]);
    if (this.cachedKey === key) return this.cached;
    let result;
    try {
      if (!selection || !['selected', 'workspace', 'compilation'].includes(selection.mode) || !Array.isArray(selection.directories) || !Array.isArray(selection.files) || selection.excludedDirectories !== undefined && !Array.isArray(selection.excludedDirectories) || selection.excludedFiles !== undefined && !Array.isArray(selection.excludedFiles)) throw new Error('工程文件选择配置无效');
      const selected = selection.mode !== 'workspace';
      const includedDirectories = selection.mode === 'selected' ? this.resolve(selection.directories, false) : [];
      const compiled = this.compilation && selection.compilationDatabase && uriKey(this.compilation.database) === uriKey(selection.compilationDatabase) && (!this.compilation.selectionKey || this.compilation.selectionKey === JSON.stringify(selection));
      const includedFiles = selected ? this.resolve(selection.mode === 'compilation' ? compiled ? this.compilation.files : [] : selection.files, false) : [];
      const sourceRules = selection.mode === 'selected' ? [
        ...includedDirectories.map(value => ({ ...value, directory: true, included: true })),
        ...includedFiles.map(value => ({ ...value, directory: false, included: true })),
        ...this.resolve(selection.excludedDirectories || [], false).map(value => ({ ...value, directory: true, included: false })),
        ...this.resolve(selection.excludedFiles || [], false).map(value => ({ ...value, directory: false, included: false }))
      ] : [];
      const excludes = this.resolve(excludedValues);
      const roots = this.workspaceRoots().filter(root =>
        !excludes.some(excluded => relativeUriPath(excluded.uri, root.uri) !== undefined));
      const files = this.resolve(fileValues, false);
      result = { compilationValidated: selection.mode === 'compilation' && Boolean(compiled), roots, excludes, files, fileKeys: new Set(files.map(file => uriKey(file.uri))), selected, includedDirectories, includedFiles, includedKeys: new Set(includedFiles.map(file => uriKey(file.uri))), sourceRules, error: undefined };
    } catch (error) { result = { roots: [], excludes: [], files: [], fileKeys: new Set(), selected: true, includedDirectories: [], includedFiles: [], includedKeys: new Set(), sourceRules: [], error: error.message }; }
    this.cachedKey = key; this.cached = result; return result;
  }
  roots() { return this.snapshot().roots; }
  key(snapshot = this.snapshot()) {
    if (snapshot.fingerprint) return snapshot.fingerprint;
    const { roots, excludes, files, error } = snapshot;
    return snapshot.fingerprint = createHash('sha256').update(JSON.stringify([roots.map(root => uriKey(root.uri)).sort(),
      excludes.map(root => uriKey(root.uri)).sort(), files.map(root => uriKey(root.uri)).sort(), snapshot.selected,
      snapshot.includedDirectories.map(root => uriKey(root.uri)).sort(), snapshot.includedFiles.map(root => uriKey(root.uri)).sort(), error || '',
      ...(snapshot.sourceRules.some(rule => !rule.included) ? [snapshot.sourceRules.filter(rule => !rule.included).map(rule => [rule.directory, uriKey(rule.uri)]).sort()] : [])])).digest('hex');
  }
  contains(uri, snapshot = this.snapshot()) {
    const { roots, excludes, fileKeys } = snapshot;
    return roots.some(root => relativeUriPath(root.uri, uri) !== undefined) &&
      (!snapshot.selected || (snapshot.sourceRules.length ? projectSourceSelected(uri, snapshot.sourceRules) : snapshot.includedKeys.has(uriKey(uri)) || snapshot.includedDirectories.some(root => relativeUriPath(root.uri, uri) !== undefined))) &&
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
    const snapshot = this.snapshot(), omitted = snapshot.sourceRules.filter(rule => !rule.included);
    for (const excluded of [...snapshot.excludes, ...omitted.filter(rule => rule.directory)]) {
      const relative = relativeUriPath(root.uri, excluded.uri);
      if (relative) {
        // Escape literal glob characters in explicitly selected directory names.
        const literal = relative.replace(/[\[\]*?{},]/g, char => char === '[' ? '[[]' : char === ']' ? '[]]' : '[' + char + ']');
        patterns.push(literal + '/**');
      }
    }
    for (const file of [...snapshot.files, ...omitted.filter(rule => !rule.directory)]) {
      const relative = relativeUriPath(root.uri, file.uri);
      if (relative) patterns.push(relative.replace(/[\[\]*?{},]/g, char => char === '[' ? '[[]' : char === ']' ? '[]]' : '[' + char + ']'));
    }
    return patterns.length > 1 ? '{' + patterns.join(',') + '}' : patterns[0];
  }
}
module.exports = { ReadingScope, scopeConfigurationChanged: changed };
