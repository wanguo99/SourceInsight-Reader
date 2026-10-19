'use strict';
const vscode = require('vscode');
const { RelationBackend } = require('../relation-backend');
const { LocalCProvider, LanguageServiceProvider } = require('./relation-providers');
function createRelationBackend(index, catalog) {
  return new RelationBackend({ local: new LocalCProvider(index), semantic: new LanguageServiceProvider(),
    settings: (key, fallback) => vscode.workspace.getConfiguration('sourceInsightInspired').get(key, fallback),
    scope: value => {
      const uri = vscode.Uri.parse(value), root = catalog.folder(uri);
      return `${root?.uri.toString() || ''}:${/\.[ch]$/i.test(uri.path) ? 'c' : uri.path.split('.').pop()}`;
    }, log: message => index.log(message) });
}
module.exports = { createRelationBackend };
