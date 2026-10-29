'use strict';
const { cSourceProjection, withoutTrivia, withoutDirectives } = require('./c-source-projection');

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
  const projected = source.includes('__cplusplus') ? cSourceProjection(source) : source;
  const code = withoutDirectives(withoutTrivia(projected), projected);
  if (/\bnamespace\s+(?:[\w:]+\s*)?\{|\b(?:class|template)\s*(?:<|\w+\s*[:{;])|\busing\s+(?:namespace\s+)?\w+\s*[=;]|\b\w+::\w+/.test(code)) return true;
  // Structs can contain C++ methods without any class/namespace keyword.
  // Inspect record bodies only: free C functions and callback fields stay C.
  for (const record of code.matchAll(/\b(?:struct|union)\s+([A-Za-z_]\w*)?\s*(?::[^;{]+)?\{/g)) {
    if (record[0].includes(':')) return true;
    let end = record.index + record[0].length, depth = 1;
    for (; end < code.length && depth; end++) { if (code[end] === '{') depth++; else if (code[end] === '}') depth--; }
    const body = code.slice(record.index + record[0].length, end - 1);
    if (/\b(?:public|protected|private)\s*:|\boperator\s*[^;{]*\(|\)\s*(?:const|noexcept|override|final)\b/.test(body)) return true;
    if (record[1] && new RegExp('(?:^|[;{}])\\s*~?' + record[1] + '\\s*\\(').test(body)) return true;
    if (/(?:^|[;{}])\s*(?:(?:static|inline|virtual|constexpr|const|volatile)\s+)*(?:(?:(?:unsigned|signed|long|short)\s+)*(?:void|int|char|float|double|bool)|(?:struct|union|enum)\s+\w+|[A-Za-z_]\w*)\s+[*&\s]*(?!(?:void|int|char|float|double|bool|unsigned|signed|long|short)\b)[A-Za-z_]\w*\s*\((?!\s*[*&])/.test(body)) return true;
  }
  return false;
}

module.exports = { decodeSource, isCppHeader };
