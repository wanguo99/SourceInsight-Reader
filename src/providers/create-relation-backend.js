'use strict';
const vscode = require('vscode');
const { RelationBackend } = require('../relation-backend');
const { LocalCProvider, LanguageServiceProvider } = require('./relation-providers');
function createRelationBackend(index, catalog, indexStore) {
  return new RelationBackend({ local: new LocalCProvider(index), semantic: new LanguageServiceProvider(catalog, indexStore),
    settings: (key, fallback) => vscode.workspace.getConfiguration('sourceInsightReader').get(key, fallback),
    configuration: () => catalog.configurationKey?.() || '',
    scope: value => {
      const uri = vscode.Uri.parse(value), root = catalog.folder(uri);
      return `${root?.uri.toString() || ''}:${/\.[ch]$/i.test(uri.path) ? 'c' : uri.path.split('.').pop()}`;
    }, log: message => index.log(message) });
}
module.exports = { createRelationBackend };
