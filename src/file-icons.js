'use strict';
const vscode = require('vscode');

function parseTheme(text) {
  // Preserve quoted URLs and escaped quotes while accepting JSONC theme files.
  const clean = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, match => match[0] === '"' ? match : '');
  return JSON.parse(clean.replace(/("(?:\\.|[^"\\])*")|,\s*([}\]])/g, (match, string, close) => string || close));
}
const language = { c: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', js: 'javascript', ts: 'typescript', json: 'json', md: 'markdown', py: 'python', sh: 'shellscript', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', xml: 'xml', rs: 'rust', go: 'go', java: 'java', txt: 'plaintext' };
function glyph(value) {
  const match = /^\\([0-9a-f]{1,6})$/i.exec(value || '');
  return match && parseInt(match[1], 16) <= 0x10ffff ? String.fromCodePoint(parseInt(match[1], 16)) : Array.from(value || '').length === 1 ? value : undefined;
}
async function loadFileIcons(webview) {
  const id = vscode.workspace.getConfiguration('workbench').get('iconTheme', 'vs-seti');
  if (!id) return undefined;
  const extension = vscode.extensions?.all?.find(item => item.packageJSON.contributes?.iconThemes?.some(theme => theme.id === id));
  const contribution = extension?.packageJSON.contributes.iconThemes.find(theme => theme.id === id);
  if (!contribution) return undefined;
  const file = vscode.Uri.joinPath(extension.extensionUri, contribution.path), base = vscode.Uri.joinPath(file, '..');
  const data = parseTheme(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8'));
  const kind = vscode.window.activeColorTheme?.kind;
  const override = kind === 1 || kind === 4 ? data.light : kind === 3 ? data.highContrast : undefined;
  const theme = { ...data, ...override };
  for (const key of ['fileNames', 'fileExtensions', 'languageIds', 'folderNames', 'folderNamesExpanded', 'rootFolderNames', 'rootFolderNamesExpanded']) {
    theme[key] = { ...data[key], ...override?.[key] };
  }
  const definitions = { ...data.iconDefinitions, ...override?.iconDefinitions };
  const local = value => typeof value === 'string' && !/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(value)
    ? webview.asWebviewUri(vscode.Uri.joinPath(base, value)).toString() : undefined;
  const fonts = new Map(), css = [];
  for (const [index, font] of (data.fonts || []).entries()) {
    const family = `si-files-icon-${index}`;
    fonts.set(font.id, { family, size: /^[\d.]+(?:px|em|%)$/.test(font.size || '') ? font.size : '100%' });
    const sources = (font.src || []).flatMap(source => {
      const url = local(source.path);
      return url && ['woff', 'woff2', 'truetype', 'opentype'].includes(source.format) ? [`url(${JSON.stringify(url)}) format("${source.format}")`] : [];
    });
    if (sources.length) css.push(`@font-face{font-family:"${family}";src:${sources.join(',')};font-weight:normal;font-style:normal;}`);
  }
  const iconFor = (name, type, expanded, root = false) => {
    const key = name.toLowerCase(); let icon;
    if (type === 'directory') {
      icon = root ? (expanded ? theme.rootFolderNamesExpanded?.[key] || theme.rootFolderNames?.[key] : theme.rootFolderNames?.[key]) : undefined;
      icon ||= expanded ? theme.folderNamesExpanded?.[key] || theme.folderNames?.[key] : theme.folderNames?.[key];
      icon ||= root ? (expanded ? theme.rootFolderExpanded : theme.rootFolder) : undefined;
      icon ||= expanded ? theme.folderExpanded : theme.folder;
    } else {
      icon = theme.fileNames?.[key];
      const parts = key.split('.');
      for (let i = 1; !icon && i < parts.length; i++) icon = theme.fileExtensions?.[parts.slice(i).join('.')];
      icon ||= theme.languageIds?.[language[parts.at(-1)]];
      icon ||= theme.file;
    }
    const definition = definitions?.[icon]; if (!definition) return undefined;
    const uri = local(definition.iconPath); if (uri) return { uri };
    const text = glyph(definition.fontCharacter), font = fonts.get(definition.fontId) || fonts.values().next().value;
    return text && font ? { glyph: text, family: font.family, size: font.size,
      color: /^#[\da-f]{3,8}$/i.test(definition.fontColor || '') ? definition.fontColor : undefined } : undefined;
  };
  return { root: extension.extensionUri, css: css.join('\n'), iconFor };
}
module.exports = { loadFileIcons, parseTheme, glyph };
