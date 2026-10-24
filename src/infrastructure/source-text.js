'use strict';
const { cSourceProjection, withoutTrivia } = require('./c-source-projection');

// Match the editor's configured encoding, honoring BOMs before configuration.
// Invalid bytes must fail explicitly instead of introducing replacement symbols.
function decodeSource(bytes, encoding = 'utf8', onWarning = message => {}) {
  const buffer = Buffer.from(bytes);
  let label = ({ utf8: 'utf-8', utf8bom: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be',
    windows1252: 'windows-1252', cp936: 'gbk' })[encoding.toLowerCase()] || encoding;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) label = 'utf-16le';
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) label = 'utf-16be';
  else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) label = 'utf-8';
  let text;
  try { text = new TextDecoder(label, { fatal: true }).decode(buffer); }
  catch (error) {
    // Invalid UTF-8 bytes in comments cannot change identifiers. Use the same
    // replacement text as an UTF-8 editor, without guessing a legacy encoding.
    const recovered = /^utf-?8$/i.test(label) ? new TextDecoder('utf-8').decode(buffer) : undefined;
    if (recovered && !withoutTrivia(recovered, true).includes('\ufffd')) {
      text = recovered; onWarning('注释含非 UTF-8 字节，使用编辑器替换字符保留位置；源码未修改');
    } else throw new Error(`无法按 ${label} 解码源码，请检查 files.encoding：${error.message}`);
  }
  if (text.includes('\0')) throw new Error('源码包含 NUL，请检查文件编码或二进制文件');
  return text;
}

function isCppHeader(source, filePath) {
  if (!/\.h$/i.test(filePath)) return false;
  const code = withoutTrivia(source.includes('__cplusplus') ? cSourceProjection(source) : source);
  return /\bnamespace\s+(?:[\w:]+\s*)?\{|\b(?:class|template)\s*(?:<|\w+\s*[:{;])|\busing\s+(?:namespace\s+)?\w+\s*[=;]|\b\w+::\w+/.test(code);
}

module.exports = { decodeSource, isCppHeader };
