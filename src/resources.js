'use strict';

// URI operations only: never join workspace resources with host-specific filesystem paths.
function parts(uri) {
  const parsed = new URL(uri.toString());
  const path = uri.path ?? decodeURIComponent(parsed.pathname);
  const scheme = (uri.scheme || parsed.protocol.slice(0, -1)).toLowerCase();
  const authority = (uri.authority ?? parsed.host).toLowerCase();
  const windowsFile = scheme === 'file' && (/^\/[a-z]:\//i.test(path) || Boolean(authority));
  return { scheme, authority, path, windowsFile, suffix: parsed.search + parsed.hash };
}

function uriKey(uri) {
  const value = parts(uri);
  const path = value.windowsFile ? value.path.toLowerCase() : value.path;
  return `${value.scheme}://${value.authority}${path}${value.suffix}`;
}

function sameUri(a, b) { return Boolean(a && b && uriKey(a) === uriKey(b)); }

function relativeUriPath(root, child) {
  const a = parts(root), b = parts(child);
  if (a.scheme !== b.scheme || a.authority !== b.authority) return undefined;
  const rootPath = a.path.replace(/\/+$/, '');
  const fold = value => a.windowsFile ? value.toLowerCase() : value;
  if (fold(rootPath) === fold(b.path.replace(/\/+$/, ''))) return '';
  if (!fold(b.path).startsWith(fold(rootPath) + '/')) return undefined;
  return b.path.slice(rootPath.length + 1);
}

module.exports = { uriKey, sameUri, relativeUriPath };
