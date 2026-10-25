'use strict';
const path = require('node:path');
const os = require('node:os');
function indexStorageDirectory(context, configured = '') {
  if (configured) {
    const expanded = configured.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/\$\{userHome\}/g, os.homedir());
    if (!path.isAbsolute(expanded)) throw new Error('indexCacheDirectory必须是绝对路径或以~/${userHome}开头');
    return path.normalize(expanded);
  }
  const storage = context.globalStorageUri || context.storageUri;
  return storage ? path.join(storage.fsPath, 'indexes') : undefined;
}
module.exports = { indexStorageDirectory };
