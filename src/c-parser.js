'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let initialization;

async function createParser() {
  const directory = path.join(__dirname, '../vendor/tree-sitter');
  // Keep third-party runtime code outside our checked source tree.
  const runtime = require(path.join(directory, 'tree-sitter.js'));
  if (!initialization) initialization = (async () => {
    await runtime.Parser.init({ wasmBinary: fs.readFileSync(path.join(directory, 'tree-sitter.wasm')) });
    return runtime.Language.load(fs.readFileSync(path.join(directory, 'tree-sitter-c.wasm')));
  })().catch(error => { initialization = undefined; throw error; });
  const language = await initialization;
  const parser = new runtime.Parser();
  parser.setLanguage(language);
  return parser;
}

function identifier(node) {
  if (!node) return undefined;
  if (['identifier', 'field_identifier', 'type_identifier'].includes(node.type)) return node;
  const inner = node.childForFieldName('declarator');
  if (inner) return identifier(inner);
  if (node.type === 'parenthesized_declarator') return identifier(node.namedChildren[0]);
}

// Index offsets and positions in the JS binding are UTF-16, as required by VS Code.
function parseC(parser, source, uri, filePath) {
  const tree = parser.parse(source);
  if (!tree) throw new Error('C parser did not return a syntax tree');
  const range = node => ({ start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column } });
  const result = { uri, path: filePath, hash: crypto.createHash('sha256').update(source).digest('hex'),
    functions: [], declarations: [], symbols: [], calls: [], includes: [], macros: [], hasErrors: tree.rootNode.hasError };
  const symbol = (name, owner, kind, detail = '', children = []) => ({ name: name.text, uri, kind,
    range: range(owner), selectionRange: range(name), detail, children, origin: 'local',
    ...(detail === 'union' ? { category: 'union' } : detail === 'typedef' ? { category: 'typedef' } : {}) });
  const members = body => {
    const children = [];
    for (const field of body.namedChildren) {
      if (field.type === 'enumerator') {
        const id = field.childForFieldName('name'); if (id) children.push(symbol(id, field, 21));
      } else if (field.type === 'field_declaration') {
        for (const declarator of field.childrenForFieldName('declarator')) {
          const id = identifier(declarator);
          if (id) children.push(symbol(id, field, 7, field.childForFieldName('type')?.text || ''));
        }
      }
    }
    return children;
  };
  const isFunction = declarator => {
    let current = declarator;
    while (current) {
      if (current.type === 'function_declarator') return current.childForFieldName('declarator')?.type === 'identifier';
      current = current.childForFieldName('declarator');
    }
    return false;
  };
  try {
    const visit = (node, fn) => {
      if (node.type === 'preproc_include') {
        const target = node.childForFieldName('path');
        if (target && ['string_literal', 'system_lib_string'].includes(target.type)) {
          result.includes.push({ name: target.text.slice(1, -1), quoted: target.type === 'string_literal' });
        }
        return;
      }
      if (['preproc_def', 'preproc_function_def'].includes(node.type)) {
        const name = node.childForFieldName('name');
        if (name) result.macros.push(name.text);
        return;
      }
      if (node.type === 'function_definition') {
        const name = identifier(node.childForFieldName('declarator'));
        const body = node.childForFieldName('body');
        if (!name || !body) return;
        fn = { id: `${uri}#${name.startIndex}:${name.text}`, name: name.text,
          uri, range: range(node), selectionRange: range(name),
          static: node.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'static'),
          bindings: [] };
        result.functions.push(fn);
        result.symbols.push(symbol(name, node, 11,
          source.slice(node.startIndex, body.startIndex).replace(/\s+/g, ' ').trim().slice(0, 240)));
        const params = current => {
          if (current.type === 'parameter_declaration') {
            const id = identifier(current.childForFieldName('declarator'));
            if (id) fn.bindings.push({ name: id.text, start: body.startIndex, end: body.endIndex });
            return;
          }
          for (const child of current.namedChildren) params(child);
        };
        params(node.childForFieldName('declarator'));
        // The declarator contains a signature, not executable calls.
        visit(body, fn); return;
      }
      if (!fn && ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(node.type)) {
        const name = node.childForFieldName('name'), body = node.childForFieldName('body');
        if (name && body) {
          result.symbols.push(symbol(name, node, node.type === 'enum_specifier' ? 9 : 22,
            node.type.replace('_specifier', ''), members(body)));
        }
      }
      if (!fn && ['declaration', 'type_definition'].includes(node.type)) {
        for (const declarator of node.childrenForFieldName('declarator')) {
          const id = identifier(declarator); if (!id) continue;
          const functionDeclaration = isFunction(declarator);
          if (functionDeclaration) result.declarations.push({ name: id.text, range: range(id),
            static: node.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'static') });
          const kind = functionDeclaration ? 11 : node.type === 'type_definition' ? 25 : 12;
          const item = symbol(id, node, kind, node.type === 'type_definition' ? 'typedef'
            : `${functionDeclaration ? '声明 · ' : ''}${node.childForFieldName('type')?.text || ''}`);
          const type = node.childForFieldName('type'), body = type?.childForFieldName('body');
          if (node.type === 'type_definition' && body && ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(type.type)) {
            item.kind = type.type === 'enum_specifier' ? 9 : 22;
            item.category = type.type.replace('_specifier', '');
            item.detail = `typedef ${item.category}`; item.children = members(body);
          }
          result.symbols.push(item);
        }
      }
      if (fn && node.type === 'declaration') {
        let scope = node.parent;
        while (scope && !['compound_statement', 'for_statement', 'function_definition'].includes(scope.type)) scope = scope.parent;
        for (const declarator of node.childrenForFieldName('declarator')) {
          const id = identifier(declarator);
          if (id) fn.bindings.push({ name: id.text, start: id.startIndex, end: scope?.endIndex ?? node.endIndex });
        }
      }
      if (fn && node.type === 'call_expression') {
        const callee = node.childForFieldName('function');
        if (callee) result.calls.push({ caller: fn.id, name: callee.text, range: range(callee),
          offset: callee.startIndex, indirect: callee.type !== 'identifier' });
      }
      for (const child of node.namedChildren) visit(child, fn);
    };
    visit(tree.rootNode, undefined);
    const byId = new Map(result.functions.map(fn => [fn.id, fn]));
    for (const call of result.calls) {
      const fn = byId.get(call.caller);
      if (fn?.bindings.some(binding => binding.name === call.name && binding.start <= call.offset && call.offset < binding.end)) call.indirect = true;
    }
    // Local binding spans are only needed while classifying direct calls.
    for (const fn of result.functions) delete fn.bindings;
    return result;
  } finally { tree.delete(); }
}

module.exports = { createParser, parseC };
