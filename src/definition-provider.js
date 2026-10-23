'use strict';
const vscode = require('vscode');

// Use the native editor's definition links (Ctrl+hover/click and F12), without
// querying executeDefinitionProvider here, which would recurse into ourselves.
function registerLocalDefinitions(index) {
  return vscode.languages.registerDefinitionProvider([{ language: 'c', scheme: 'file' }], {
    async provideDefinition(document, position, token) {
      if (token.isCancellationRequested || !index.enabled() || !index.supports(document.uri)) return [];
      if (index.isSemanticQuery?.(document.uri, position)) return [];
      const word = document.getWordRangeAtPosition(position);
      if (!word) return [];
      try {
        const locations = await index.definitions(document.uri, position);
        if (token.isCancellationRequested) return [];
        return locations.map(location => ({ originSelectionRange: word,
          targetUri: location.uri, targetRange: location.range, targetSelectionRange: location.range }));
      } catch (error) {
        index.log(`本地定义链接查询失败：${error.message}`); return [];
      }
    }
  });
}
module.exports = { registerLocalDefinitions };
