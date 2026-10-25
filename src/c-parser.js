'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isCppHeader } = require('./infrastructure/source-text');
const { cSourceProjection } = require('./infrastructure/c-source-projection');
const { preprocessorFacts, mergePreprocessorFacts } = require('./infrastructure/preprocessor-facts');
const initializations = new Map();

async function createParser(grammar = 'c') {
  const directory = path.join(__dirname, '../vendor/tree-sitter');
  // Keep third-party runtime code outside our checked source tree.
  const runtime = require(path.join(directory, 'tree-sitter.js'));
  if (!['c', 'cpp'].includes(grammar)) throw new Error('Unsupported parser grammar');
  if (!initializations.has(grammar)) initializations.set(grammar, (async () => {
    await runtime.Parser.init({ wasmBinary: fs.readFileSync(path.join(directory, 'tree-sitter.wasm')) });
    return runtime.Language.load(fs.readFileSync(path.join(directory, `tree-sitter-${grammar}.wasm`)));
  })().catch(error => { initializations.delete(grammar); throw error; }));
  const language = await initializations.get(grammar);
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
function parseC(parser, source, uri, filePath, checkMemory = () => {}, options = { declarationsOnly: false }) {
  const now = require('./infrastructure/resource-clock').extractionClock(checkMemory);
  if (isCppHeader(source, filePath)) throw new Error('C++ 头文件需要 C++ 语言服务，本地 C 索引不解析该文件');
  parser.setTimeoutMicros(3000000);
  const projected = cSourceProjection(source);
  let tree = parser.parse(projected);
  if (!tree) { parser.reset(); throw new Error('单文件 C 解析超过资源预算，请使用语言服务或排除此文件'); }
  // Keep every already-valid tree unchanged. Only retry small recovered files
  // with function-body directives projected, and accept a wholly valid result.
  if (tree.rootNode.hasError && source.length <= 2 * 1024 * 1024) {
    const recovered = cSourceProjection(source, { projectBlocks: true });
    if (recovered !== projected) {
      const alternate = parser.parse(recovered);
      if (!alternate) parser.reset();
      else if (!alternate.rootNode.hasError && alternate.rootNode.descendantsOfType('function_definition').length >= tree.rootNode.descendantsOfType('function_definition').length) { tree.delete(); tree = alternate; }
      else alternate.delete();
    }
  }
  const deadline = now() + 3000; let visited = 0;
  const checkBudget = () => { if (++visited % 2048 === 0) {
    if (now() > deadline) throw new Error('单文件 C 事实提取超过 3 秒预算');
    if (visited > 500000) throw new Error('单文件 C 事实数量超过资源预算');
    checkMemory();
  } };
  const ranges = new Map(), strings = new Map();
  const intern = value => {
    if (strings.has(value)) return strings.get(value);
    // A V8 sliced string can retain the entire source buffer for one name.
    const copy = Buffer.from(value, 'utf8').toString('utf8'); strings.set(copy, copy); return copy;
  };
  const range = node => {
    if (ranges.has(node.id)) return ranges.get(node.id);
    const start = node.startPosition, end = node.endPosition;
    const value = { start: { line: start.row, character: start.column }, end: { line: end.row, character: end.column } };
    ranges.set(node.id, value); return value;
  };
  const result = { uri, path: filePath, hash: crypto.createHash('sha256').update(source).digest('hex'),
    functions: [], declarations: [], symbols: [], locals: [], fieldTypes: {}, identifierNames: [], identifierData: undefined, calls: [], includes: [], macros: [], hasErrors: tree.rootNode.hasError, parseIssues: [],
    ...(options.declarationsOnly ? { declarationsOnly: true } : {}) };
  const identifierData = [], identifierNames = new Map();
  const symbol = (name, owner, kind, detail = '', children = []) => ({ name: intern(name.text), uri, kind,
    range: range(owner), selectionRange: range(name), detail: intern(detail), children, origin: 'local',
    ...(detail === 'union' ? { category: 'union' } : detail === 'typedef' ? { category: 'typedef' } : {}) });
  const declaredType = node => {
    const type = node.childForFieldName('type');
    if (!type) return undefined;
    const tag = ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(type.type) ? type.type.replace('_specifier', '') : undefined;
    const rawName = tag ? type.childForFieldName('name')?.text : type.text, name = rawName === undefined ? undefined : intern(rawName);
    const body = type.childForFieldName('body');
    return { name, tag, ...(body && !name ? { children: members(body) } : {}) };
  };
  const members = body => {
    const children = [];
    const visit = field => {
      checkBudget();
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
  const receiverType = node => {
    if (!node) return undefined;
    if (['cast_expression', 'compound_literal_expression'].includes(node.type)) return declaredType(node.childForFieldName('type'));
    if (['parenthesized_expression', 'subscript_expression', 'pointer_expression'].includes(node.type)) return receiverType(node.childForFieldName('argument') || node.namedChildren[0]);
  };
  const designatorType = node => {
    let owner = node.parent; const members = [];
    while (owner && !['declaration', 'compound_literal_expression', 'function_definition'].includes(owner.type)) {
      if (owner.type === 'initializer_pair') {
        const prefix = owner.namedChildren.filter(child => child.type === 'field_designator' && child.endIndex <= node.startIndex)
          .map(child => child.namedChildren[0]?.text).filter(Boolean);
        members.unshift(...prefix);
      }
      owner = owner.parent;
    }
    const type = owner?.type === 'declaration' ? declaredType(owner) : owner?.type === 'compound_literal_expression' ? declaredType(owner.childForFieldName('type')) : undefined;
    return type && { type, members };
  };
  const addIdentifier = node => {
    const name = intern(node.text);
    if (!identifierNames.has(name)) { identifierNames.set(name, result.identifierNames.length); result.identifierNames.push(name); }
    const start = node.startPosition, end = node.endPosition, parent = node.parent?.type;
    const tag = ['', 'struct_specifier', 'union_specifier', 'enum_specifier'].indexOf(parent);
    const namespace = tag > 0 ? 3 : node.type === 'type_identifier' ? 1 : node.type === 'field_identifier' ? 2 : 0;
    const receiver = namespace === 2 ? receiverPosition(node.parent?.childForFieldName('argument')) : undefined;
    if (namespace === 2) {
      const explicit = node.parent?.type === 'field_expression' ? receiverType(node.parent.childForFieldName('argument')) : undefined;
      const typed = explicit ? { type: explicit, members: [] } : node.parent?.type === 'field_designator' ? designatorType(node) : undefined;
      if (typed) result.fieldTypes[`${start.row}:${start.column}`] = typed;
    }
    identifierData.push(identifierNames.get(name), start.row, start.column, end.row, end.column, namespace, Math.max(0, tag), receiver?.line ?? -1, receiver?.character ?? -1);
  };
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
      checkBudget();
      if ((node.type === 'ERROR' || node.isMissing) && result.parseIssues.length < 3) result.parseIssues.push({ range: range(node), context: node.parent?.type || 'translation_unit' });
      if (node.hasError && result.parseIssues.length < 3) for (const child of node.children) {
        if (child.isMissing && !child.isNamed) result.parseIssues.push({ range: range(child), context: node.type });
        if (result.parseIssues.length >= 3) break;
      }
      if (['number_literal', 'string_literal', 'char_literal'].includes(node.type)) return;
      if (node.type === 'initializer_list') {
        const text = node.text;
        // Generated numeric matrices can contain millions of AST leaves but
        // no navigable names. Preserve the declaration and avoid materializing
        // all child wrappers. Identifier expressions such as ++e are excluded.
        if (/^[-+0-9a-fA-FxXpPuUlL.,{}\s]*$/.test(text) && !/\b[A-Za-z_]\w*\b/.test(text)) return;
      }
      if (['identifier', 'type_identifier', 'field_identifier'].includes(node.type)) {
        addIdentifier(node);
      }
      if (!fn && node.type === 'function_declarator') {
        const parameters = node.childForFieldName('parameters');
        for (const parameter of parameters?.namedChildren || []) {
          if (parameter.type !== 'parameter_declaration') continue;
          const id = identifier(parameter.childForFieldName('declarator'));
          if (id) result.locals.push({ ...symbol(id, parameter, 12), declaredType: declaredType(parameter),
            scope: { start: range(id).start, end: range(node).end } });
        }
      }
      if (node.type === 'preproc_include') {
        const target = node.childForFieldName('path');
        if (target && ['string_literal', 'system_lib_string'].includes(target.type)) {
          result.includes.push({ name: intern(target.text.slice(1, -1)), quoted: target.type === 'string_literal' });
        }
        return;
      }
      if (['preproc_def', 'preproc_function_def'].includes(node.type)) {
        const name = node.childForFieldName('name');
        if (name) {
          result.macros.push(intern(name.text));
          result.symbols.push({ ...symbol(name, node, 13, node.text.slice(0, 180)), category: 'macro' });
          addIdentifier(name);
        }
        return;
      }
      if (node.type === 'function_definition') {
        const name = identifier(node.childForFieldName('declarator'));
        const body = node.childForFieldName('body');
        if (!name || !body) return;
        fn = { id: `${uri}#${name.startIndex}:${intern(name.text)}`, name: intern(name.text),
          uri, range: range(node), selectionRange: range(name),
          static: node.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'static'),
          declaredType: declaredType(node), bindings: [] };
        result.functions.push(fn);
        result.symbols.push({ ...symbol(name, node, 11,
          source.slice(node.startIndex, body.startIndex).replace(/\s+/g, ' ').trim().slice(0, 240)), declaredType: fn.declaredType, static: fn.static });
        // Signatures are not executable calls, but their type names and
        // identifiers still need positions for definition navigation.
        const signatureIdentifiers = current => {
          checkBudget();
          if (['identifier', 'type_identifier'].includes(current.type)) {
            addIdentifier(current);
          }
          for (const child of current.namedChildren) signatureIdentifiers(child);
        };
        for (const child of node.namedChildren) if (child.id !== body.id) signatureIdentifiers(child);
        const params = current => {
          checkBudget();
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
        if (!options.declarationsOnly) visit(body, fn); return;
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
          if (functionDeclaration) result.declarations.push({ name: intern(id.text), range: range(id),
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
          if (callee) result.calls.push({ caller: fn.id, name: intern(callee.text), range: range(callee),
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
    for (const call of result.calls) delete call.offset;
    result.identifierData = Int32Array.from(identifierData);
    return mergePreprocessorFacts(result, preprocessorFacts(source, uri, false, checkMemory));
  } finally { tree.delete(); }
}

module.exports = { createParser, parseC };
