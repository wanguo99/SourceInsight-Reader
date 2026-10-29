'use strict';
const { relativeUriPath, uriKey } = require('../resources');

// Each rule array is an immutable snapshot. Index exact files once, keeping
// mixed directory/file imports from scanning every file rule for each query.
const compiled = new WeakMap();
function compile(rules) {
  if (compiled.has(rules)) return compiled.get(rules);
  const files = new Map(), directories = [];
  for (const rule of rules) {
    if (rule.directory) directories.push(rule);
    else {
      const key = uriKey(rule.uri);
      if (!files.has(key) || !rule.included) files.set(key, rule.included);
    }
  }
  const result = { files, directories }; compiled.set(rules, result); return result;
}

// More specific import choices override their parent; independent global
// exclusions are applied separately by ReadingScope and always retain priority.
function projectSourceSelected(uri, rules) {
  const { files, directories } = compile(rules), exact = files.get(uriKey(uri));
  if (exact === false) return false;
  let selected = exact ?? false, distance = exact === undefined ? Infinity : 0;
  for (const rule of directories) {
    const relative = relativeUriPath(rule.uri, uri);
    if (relative === undefined || !rule.directory && relative !== '') continue;
    if (relative.length < distance || relative.length === distance && !rule.included) {
      distance = relative.length; selected = rule.included;
    }
  }
  return selected;
}
function toggleProjectSource(rules, node, included) {
  const next = rules.filter(rule => relativeUriPath(node.uri, rule.uri) === undefined);
  return projectSourceSelected(node.uri, next) === included ? next : [...next, { ...node, included }];
}
function partialProjectSource(uri, rules) {
  const selected = projectSourceSelected(uri, rules);
  return rules.some(rule => rule.included !== selected && relativeUriPath(uri, rule.uri) !== undefined && projectSourceSelected(rule.uri, rules) !== selected);
}
module.exports = { projectSourceSelected, toggleProjectSource, partialProjectSource };
