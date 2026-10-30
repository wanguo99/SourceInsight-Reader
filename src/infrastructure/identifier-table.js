'use strict';
const os = require('node:os');
const WIDTH = 9, INVOCATION_FLAG = 4, TAG_MASK = 3;
// Share the lexical invocation check across AST and projected macro tokens.
function isInvocation(source, at) {
  while (at < source.length) {
    if (/\s/.test(source[at])) { at++; continue; }
    if (source.startsWith('/*',at)) { const end=source.indexOf('*/',at+2); if (end<0) return false; at=end+2; continue; }
    if (source.startsWith('//',at)) {
      let next = at + 2;
      while (true) {
        const end = source.indexOf('\n',next); if (end < 0) return false;
        at = end + 1;
        if (source[end-1] !== '\\' && !(source[end-1] === '\r' && source[end-2] === '\\')) break;
        next = at;
      }
      continue;
    }
    if (source.startsWith('\\\n',at)) { at += 2; continue; }
    if (source.startsWith('\\\r\n',at)) { at += 3; continue; }
    return source[at]==='(';
  }
  return false;
}
const namespaces = ['value', 'type', 'field', 'tag', 'label'];
const tags = ['', 'struct_specifier', 'union_specifier', 'enum_specifier'];
function unpack(file, at) {
  const data = file.identifierData;
  return { name: file.identifierNames[data[at]], range: { start: { line: data[at + 1], character: data[at + 2] }, end: { line: data[at + 3], character: data[at + 4] } },
    namespace: namespaces[data[at + 5]], type: tags[data[at + 6] & TAG_MASK],
    ...(data[at + 6] & INVOCATION_FLAG ? { invoked: true } : {}),
    ...(data[at + 7] >= 0 ? { receiver: { line: data[at + 7], character: data[at + 8] } } : {}) };
}
function identifierAt(file, point) {
  if (Array.isArray(file.identifiers)) return file.identifiers.find(token =>
    (token.range.start.line < point.line || token.range.start.line === point.line && token.range.start.character <= point.character) &&
    (token.range.end.line > point.line || token.range.end.line === point.line && token.range.end.character > point.character));
  const data = file.identifierData;
  if (!data?.length) return undefined;
  let low = 0, high = data.length / WIDTH;
  while (low < high) {
    const mid = (low + high) >>> 1, at = mid * WIDTH;
    if (data[at + 1] < point.line || data[at + 1] === point.line && data[at + 2] <= point.character) low = mid + 1; else high = mid;
  }
  const at = (low - 1) * WIDTH;
  return at >= 0 && (data[at + 3] > point.line || data[at + 3] === point.line && data[at + 4] > point.character) ? unpack(file, at) : undefined;
}
function* identifiersNamed(file, name) {
  if (Array.isArray(file.identifiers)) { for (const token of file.identifiers) if (token.name === name) yield token; return; }
  const id = file.identifierNames?.indexOf(name) ?? -1;
  if (id < 0) return;
  for (let at = 0; at < file.identifierData.length; at += WIDTH) if (file.identifierData[at] === id) yield unpack(file, at);
}
function encodeFacts(facts) {
  const { scopeKey, indexExclude, identifierData, ...value } = facts;
  if (!identifierData) return value;
  let buffer = Buffer.from(identifierData.buffer, identifierData.byteOffset, identifierData.byteLength);
  if (os.endianness() !== 'LE') buffer = Buffer.from(buffer).swap32();
  return { ...value, identifierEncoding: 'i32le-v1', identifierData: buffer.toString('base64') };
}
function decodeFacts(value) {
  if (value.identifierEncoding !== 'i32le-v1') return value;
  const buffer = Buffer.from(value.identifierData, 'base64');
  if (buffer.length % (WIDTH * 4) || !Array.isArray(value.identifierNames)) throw new Error('Invalid packed identifier cache');
  if (os.endianness() !== 'LE') buffer.swap32();
  const data = new Int32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { identifierEncoding, ...facts } = value;
  const strings = new Map(), positions = new Map(), ranges = new Map();
  const share = value => {
    if (typeof value === 'string') { if (!strings.has(value)) strings.set(value, value); return strings.get(value); }
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
    if (Number.isInteger(value.line) && Number.isInteger(value.character)) {
      const key = `${value.line}:${value.character}`;
      if (!positions.has(key)) positions.set(key, value); return positions.get(key);
    }
    for (const key of Object.keys(value)) value[key] = share(value[key]);
    if (value.start?.line !== undefined && value.end?.line !== undefined) {
      const key = `${value.start.line}:${value.start.character}:${value.end.line}:${value.end.character}`;
      if (!ranges.has(key)) ranges.set(key, value); return ranges.get(key);
    }
    return value;
  };
  return share({ ...facts, identifierData: data });
}
module.exports = { WIDTH, INVOCATION_FLAG, TAG_MASK, isInvocation, identifierAt, identifiersNamed, encodeFacts, decodeFacts };
