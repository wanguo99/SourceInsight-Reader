'use strict';
const path = require('node:path');
const os = require('node:os');
const { projectStorageDirectory } = require('./cache-layout');
function configuredDirectory(configured, setting) {
  if (configured) {
    const expanded = configured.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/\$\{userHome\}/g, os.homedir());
    if (!path.isAbsolute(expanded)) throw new Error(setting + '必须是绝对路径或以~/${userHome}开头');
    return path.normalize(expanded);
  }
}
function cacheStorageDirectory(context, configured = '') {
  if (configured) return configuredDirectory(configured, 'cacheDirectory');
  return (context.globalStorageUri || context.storageUri)?.fsPath;
}
function indexStorageDirectory(context, configured = '', project = 'empty-window') {
  const root = cacheStorageDirectory(context, configured);
  return root ? path.join(projectStorageDirectory(root, project), 'indexes') : undefined;
}
function logStorageDirectory(context, configured = '', project = 'empty-window') {
  const root = cacheStorageDirectory(context, configured);
  return root ? path.join(projectStorageDirectory(root, project), 'logs') : context.logUri?.fsPath;
}
module.exports = { cacheStorageDirectory, indexStorageDirectory, logStorageDirectory, configuredDirectory };
