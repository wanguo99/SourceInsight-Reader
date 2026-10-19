'use strict';

/** @typedef {string | { toString(): string, path?: string, scheme?: string, authority?: string }} Resource */
// URI operations only: never join workspace resources with host-specific filesystem paths.
/** @param {Resource} uri */
function parts(uri) {
  const parsed = new URL(uri.toString());
  const path = (typeof uri === 'string' ? undefined : uri.path) ?? decodeURIComponent(parsed.pathname);
  const scheme = ((typeof uri === 'string' ? undefined : uri.scheme) || parsed.protocol.slice(0, -1)).toLowerCase();
  const authority = ((typeof uri === 'string' ? undefined : uri.authority) ?? parsed.host).toLowerCase();
  const windowsFile = scheme === 'file' && (/^\/[a-z]:\//i.test(path) || Boolean(authority));
  return { scheme, authority, path, windowsFile, suffix: parsed.search + parsed.hash };
}

/** @param {Resource} uri */
function uriKey(uri) {
  const value = parts(uri);
  const path = value.windowsFile ? value.path.toLowerCase() : value.path;
  return `${value.scheme}://${value.authority}${path}${value.suffix}`;
}

/** @param {Resource | undefined | null} a @param {Resource | undefined | null} b */
function sameUri(a, b) { return Boolean(a && b && uriKey(a) === uriKey(b)); }

/** @param {Resource} root @param {Resource} child */
function relativeUriPath(root, child) {
  const a = parts(root), b = parts(child);
  if (a.scheme !== b.scheme || a.authority !== b.authority) return undefined;
  const rootPath = a.path.replace(/\/+$/, '');
  /** @param {string} value */
  const fold = value => a.windowsFile ? value.toLowerCase() : value;
  if (fold(rootPath) === fold(b.path.replace(/\/+$/, ''))) return '';
  if (!fold(b.path).startsWith(fold(rootPath) + '/')) return undefined;
  return b.path.slice(rootPath.length + 1);
}

module.exports = { uriKey, sameUri, relativeUriPath };
