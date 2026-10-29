'use strict';
const vscode = require('vscode');
const { sameUri } = require('../resources');

function projectAllows(catalog, source, target) {
  if (!catalog) return true;
  const from = typeof source === 'string' ? vscode.Uri.parse(source) : source;
  const to = typeof target === 'string' ? vscode.Uri.parse(target) : target;
  if (!from || !to || !catalog.accepts(from) || !catalog.accepts(to)) return false;
  const project = uri => catalog.projectKey?.(uri) || catalog.folder?.(uri)?.uri.toString();
  // Catalog adapters without project identities still enforce their selection.
  if (!catalog.projectKey && !catalog.folder) return true;
  const left = project(from), right = project(to);
  return Boolean(left && right && (left === right || /^[a-z][\w+.-]*:\/\//i.test(left) && /^[a-z][\w+.-]*:\/\//i.test(right) && sameUri(left, right)));
}

function projectResults(catalog, source, values) {
  if (!Array.isArray(values)) return values;
  return values.filter(value => {
    const target = value?.targetUri || value?.location?.uri || value?.from?.uri || value?.to?.uri || value?.uri;
    return !target || projectAllows(catalog, source, target);
  });
}
module.exports = { projectAllows, projectResults };
