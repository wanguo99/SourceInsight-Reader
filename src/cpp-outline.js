'use strict';
const crypto = require('node:crypto');
const { preprocessorFacts, mergePreprocessorFacts } = require('./infrastructure/preprocessor-facts');

// C++ names and overloads need the compiler's type system. Keep a useful offline
// outline without passing C++ methods to the C binding/call resolver.
function parseCpp(parser, source, uri, filePath, check = () => {}) {
  const now = require('./infrastructure/resource-clock').extractionClock(check);
  parser.setTimeoutMicros(3000000);
  const tree = parser.parse(source);
  if (!tree) { parser.reset(); throw new Error('C++ 文件解析超过资源预算'); }
  const result = { uri, path: filePath, hash: crypto.createHash('sha256').update(source).digest('hex'), language: 'cpp', requiresSemantic: true,
    functions: [], declarations: [], symbols: [], locals: [], calls: [], identifierNames: [], identifierData: new Uint32Array(), includes: [], macros: [], hasErrors: tree.rootNode.hasError, parseIssues: [] };
  const range = node => ({ start: { line: node.startPosition.row, character: node.startPosition.column }, end: { line: node.endPosition.row, character: node.endPosition.column } });
  const nameOf = node => {
    if (!node) return undefined;
    if (['identifier', 'field_identifier', 'type_identifier', 'namespace_identifier', 'operator_name', 'destructor_name'].includes(node.type)) return node;
    return nameOf(node.childForFieldName('declarator')) || nameOf(node.childForFieldName('name'));
  };
  let visited = 0; const deadline = now() + 3000;
  const visit = (node, output, inClass = false) => {
    if (++visited % 1024 === 0) { check(); if (visited > 500000 || now() > deadline) throw new Error('C++ 符号提取超过资源预算'); }
    if (node.type === 'preproc_include') { const value = node.childForFieldName('path')?.text; if (value) result.includes.push({ name: value.slice(1, -1), quoted: value.startsWith('"') }); }
    const containers = { namespace_definition: 2, class_specifier: 4, struct_specifier: 22, union_specifier: 22, enum_specifier: 9 };
    let kind = containers[node.type], name = node.childForFieldName('name');
    if (node.type === 'function_definition') { kind = inClass ? 5 : 11; name = nameOf(node.childForFieldName('declarator')); }
    else if (['declaration', 'field_declaration', 'type_definition', 'alias_declaration'].includes(node.type)) {
      const declarations = node.childrenForFieldName('declarator'), declaration = declarations[0]; name = nameOf(declaration) || name;
      kind = node.type === 'type_definition' || node.type === 'alias_declaration' ? 25 : /function_declarator/.test(declaration?.type || '') ? (inClass ? 5 : 11) : inClass ? 7 : 12;
      const type = node.childForFieldName('type');
      if (type && containers[type.type]) { visit(type, output, inClass); if (!name) return; }
      for (const extra of declarations.slice(1)) {
        const extraName = nameOf(extra); if (!extraName) continue;
        const extraKind = [25].includes(kind) ? kind : /function_declarator/.test(extra.type) ? (inClass ? 5 : 11) : inClass ? 7 : 12;
        output.push({ name: Buffer.from(extraName.text).toString(), uri, kind: extraKind, range: range(node), selectionRange: range(extraName), detail: 'C++ 语法大纲 · 绑定需要语言服务', origin: 'local', children: [] });
      }
    } else if (node.type === 'enumerator') { kind = 21; name = node.childForFieldName('name'); }
    if (kind !== undefined && name) {
      const symbol = { name: Buffer.from(name.text).toString(), uri, kind, range: range(node), selectionRange: range(name), detail: 'C++ 语法大纲 · 绑定需要语言服务', origin: 'local', children: [] };
      output.push(symbol);
      if (containers[node.type]) for (const child of node.namedChildren) if (child.id !== name.id) visit(child, symbol.children, node.type !== 'namespace_definition');
      // Function bodies and variable initializers are not outline declarations.
      return;
    }
    if (!['compound_statement', 'parameter_list', 'argument_list'].includes(node.type)) for (const child of node.namedChildren) visit(child, output, inClass);
  };
  try { visit(tree.rootNode, result.symbols); return mergePreprocessorFacts(result, preprocessorFacts(source, uri, true, check)); }
  finally { tree.delete(); }
}
module.exports = { parseCpp };
