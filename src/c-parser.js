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
    functions: [], declarations: [], symbols: [], locals: [], identifiers: [], calls: [], includes: [], macros: [], hasErrors: tree.rootNode.hasError };
  const symbol = (name, owner, kind, detail = '', children = []) => ({ name: name.text, uri, kind,
    range: range(owner), selectionRange: range(name), detail, children, origin: 'local',
    ...(detail === 'union' ? { category: 'union' } : detail === 'typedef' ? { category: 'typedef' } : {}) });
  const declaredType = node => {
    const type = node.childForFieldName('type');
    if (!type) return undefined;
    const tag = ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(type.type) ? type.type.replace('_specifier', '') : undefined;
    const name = tag ? type.childForFieldName('name')?.text : type.text;
    const body = type.childForFieldName('body');
    return { name, tag, ...(body && !name ? { children: members(body) } : {}) };
  };
  const members = body => {
    const children = [];
    const visit = field => {
      if (field.type === 'enumerator') {
        const id = field.childForFieldName('name'); if (id) children.push(symbol(id, field, 21));
      } else if (field.type === 'field_declaration') {
        const declarators = field.childrenForFieldName('declarator');
        for (const declarator of declarators) {
          const id = identifier(declarator);
          if (id) children.push({ ...symbol(id, field, 7, field.childForFieldName('type')?.text || ''), declaredType: declaredType(field) });
        }
        const type = field.childForFieldName('type'), nested = type?.childForFieldName('body');
        if (!declarators.length && nested && !type.childForFieldName('name') && ['struct_specifier', 'union_specifier'].includes(type.type)) {
          children.push(...members(nested));
        }
      } else if (field.type.startsWith('preproc_')) {
        for (const child of field.namedChildren) visit(child);
      }
    };
    for (const field of body.namedChildren) visit(field);
    return children;
  };
  const receiverPosition = node => {
    if (!node) return undefined;
    if (['identifier', 'field_identifier'].includes(node.type)) return range(node).start;
    if (node.type === 'field_expression') return receiverPosition(node.childForFieldName('field'));
    if (node.type === 'subscript_expression') return receiverPosition(node.childForFieldName('argument'));
    if (['parenthesized_expression', 'pointer_expression'].includes(node.type)) return receiverPosition(node.namedChildren.at(-1));
    return undefined;
  };
  const token = node => ({ name: node.text, range: range(node), type: node.parent?.type,
    ...(node.type === 'field_identifier' ? { receiver: receiverPosition(node.parent?.childForFieldName('argument')) } : {}),
    namespace: ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(node.parent?.type) ? 'tag'
      : node.type === 'type_identifier' ? 'type' : node.type === 'field_identifier' ? 'field' : 'value' });
  const scopeOf = node => {
    let scope = node.parent;
    while (scope && !['compound_statement', 'for_statement', 'function_definition'].includes(scope.type)) scope = scope.parent;
    return scope || node;
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
      if (['identifier', 'type_identifier', 'field_identifier'].includes(node.type)) {
        result.identifiers.push(token(node));
      }
      if (node.type === 'preproc_include') {
        const target = node.childForFieldName('path');
        if (target && ['string_literal', 'system_lib_string'].includes(target.type)) {
          result.includes.push({ name: target.text.slice(1, -1), quoted: target.type === 'string_literal' });
        }
        return;
      }
      if (['preproc_def', 'preproc_function_def'].includes(node.type)) {
        const name = node.childForFieldName('name');
        if (name) {
          result.macros.push(name.text);
          result.symbols.push({ ...symbol(name, node, 13, node.text.slice(0, 180)), category: 'macro' });
          result.identifiers.push(token(name));
        }
        return;
      }
      if (node.type === 'function_definition') {
        const name = identifier(node.childForFieldName('declarator'));
        const body = node.childForFieldName('body');
        if (!name || !body) return;
        fn = { id: `${uri}#${name.startIndex}:${name.text}`, name: name.text,
          uri, range: range(node), selectionRange: range(name),
          static: node.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'static'),
          declaredType: declaredType(node), bindings: [] };
        result.functions.push(fn);
        result.symbols.push({ ...symbol(name, node, 11,
          source.slice(node.startIndex, body.startIndex).replace(/\s+/g, ' ').trim().slice(0, 240)), declaredType: fn.declaredType, static: fn.static });
        // Signatures are not executable calls, but their type names and
        // identifiers still need positions for definition navigation.
        const signatureIdentifiers = current => {
          if (['identifier', 'type_identifier'].includes(current.type)) {
            result.identifiers.push(token(current));
          }
          for (const child of current.namedChildren) signatureIdentifiers(child);
        };
        for (const child of node.namedChildren) if (child.id !== body.id) signatureIdentifiers(child);
        const params = current => {
          if (current.type === 'parameter_declaration') {
            const id = identifier(current.childForFieldName('declarator'));
            if (id) {
              fn.bindings.push({ name: id.text, start: body.startIndex, end: body.endIndex });
              result.locals.push({ ...symbol(id, current, 12), declaredType: declaredType(current), scope: { start: range(id).start, end: range(body).end } });
            }
            return;
          }
          for (const child of current.namedChildren) params(child);
        };
        params(node.childForFieldName('declarator'));
        // The declarator contains a signature, not executable calls.
        visit(body, fn); return;
      }
      if (['struct_specifier', 'union_specifier', 'enum_specifier'].includes(node.type)) {
        const name = node.childForFieldName('name'), body = node.childForFieldName('body');
        if (body) {
          const children = members(body);
          const values = name ? [{ ...symbol(name, node, node.type === 'enum_specifier' ? 9 : 22,
            node.type.replace('_specifier', ''), children), namespace: 'tag' }]
            : node.type === 'enum_specifier' ? children : [];
          if (fn) {
            const scope = { start: range(node).start, end: range(scopeOf(node)).end };
            result.locals.push(...values.map(value => ({ ...value, scope })));
          } else result.symbols.push(...values);
        }
      }
      if ((!fn && node.type === 'declaration') || node.type === 'type_definition') {
        for (const declarator of node.childrenForFieldName('declarator')) {
          const id = identifier(declarator); if (!id) continue;
          const functionDeclaration = isFunction(declarator);
          if (functionDeclaration) result.declarations.push({ name: id.text, range: range(id),
            static: node.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'static') });
          const kind = functionDeclaration ? 11 : node.type === 'type_definition' ? 25 : 12;
          const item = { ...symbol(id, node, kind, node.type === 'type_definition' ? 'typedef'
            : `${functionDeclaration ? '声明 · ' : ''}${node.childForFieldName('type')?.text || ''}`), declaredType: declaredType(node) };
          const type = node.childForFieldName('type'), body = type?.childForFieldName('body');
          if (node.type === 'type_definition' && body && ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(type.type)) {
            item.kind = type.type === 'enum_specifier' ? 9 : 22;
            item.category = type.type.replace('_specifier', '');
            item.detail = `typedef ${item.category}`; item.children = members(body);
          }
          if (fn) result.locals.push({ ...item, scope: { start: range(id).start, end: range(scopeOf(node)).end } });
          else result.symbols.push({ ...item,
            static: node.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'static'),
            declarationOnly: functionDeclaration || node.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'extern') });
        }
      }
      if (fn && node.type === 'declaration') {
        let scope = node.parent;
        while (scope && !['compound_statement', 'for_statement', 'function_definition'].includes(scope.type)) scope = scope.parent;
        for (const declarator of node.childrenForFieldName('declarator')) {
          const id = identifier(declarator);
          if (id) {
            fn.bindings.push({ name: id.text, start: id.startIndex, end: scope?.endIndex ?? node.endIndex });
            result.locals.push({ ...symbol(id, node, 12), declaredType: declaredType(node), scope: { start: range(id).start, end: range(scope || node).end } });
          }
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
