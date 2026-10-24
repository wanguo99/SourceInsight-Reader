'use strict';
const { cSourceProjection } = require('./c-source-projection');

// Single-file syntax roles only. Includes, macro expansion and conditional
// compilation require the language service; these spans never resolve symbols.
function cColorSpans(parser, source) {
  parser.setTimeoutMicros(1000000);
  const tree = parser.parse(cSourceProjection(source));
  if (!tree) { parser.reset(); throw new Error('C coloring parse budget exceeded'); }
  const deadline = Date.now() + 1000, tokens = [], bindings = new Map();
  let visited = 0;
  const nameOf = node => {
    if (!node) return undefined;
    if (['identifier', 'field_identifier', 'type_identifier'].includes(node.type)) return node;
    return nameOf(node.childForFieldName('declarator') ||
      (node.type === 'parenthesized_declarator' ? node.namedChildren[0] : undefined));
  };
  const isFunction = node => {
    for (let current = node; current; current = current.childForFieldName('declarator')) {
      if (current.type === 'function_declarator') return current.childForFieldName('declarator')?.type === 'identifier';
    }
    return false;
  };
  const scopeOf = (owner, parameter) => {
    for (let current = owner.parent; current; current = current.parent) {
      if ((parameter ? ['function_definition', 'function_declarator'] : ['compound_statement', 'for_statement']).includes(current.type)) {
        if (parameter && current.type === 'function_declarator') {
          let fn = current.parent;
          while (fn && fn.type.endsWith('declarator')) fn = fn.parent;
          if (fn?.type === 'function_definition') return fn;
        }
        return current;
      }
    }
    return tree.rootNode;
  };
  const definition = node => {
    const parent = node.parent;
    if (!parent) return undefined;
    if (parent.type === 'enumerator' && parent.childForFieldName('name')?.id === node.id) return { type: 'enumMember', owner: parent };
    if (['preproc_def', 'preproc_function_def'].includes(parent.type) && parent.childForFieldName('name')?.id === node.id) return { type: 'macro', owner: parent };
    if (['struct_specifier', 'union_specifier', 'enum_specifier'].includes(parent.type) && parent.childForFieldName('name')?.id === node.id) {
      return parent.childForFieldName('body') ? { type: parent.type === 'enum_specifier' ? 'enum' : 'struct', owner: parent } : undefined;
    }
    for (let owner = parent; owner; owner = owner.parent) {
      if (!['function_definition', 'declaration', 'parameter_declaration', 'field_declaration', 'type_definition'].includes(owner.type)) {
        if (!owner.type.endsWith('declarator')) break;
        continue;
      }
      const declarators = owner.childrenForFieldName('declarator');
      const declarator = declarators.find(value => nameOf(value)?.id === node.id);
      if (!declarator) return undefined;
      const type = owner.type === 'parameter_declaration' ? 'parameter' : owner.type === 'field_declaration' ? 'property'
        : owner.type === 'type_definition' ? 'type' : isFunction(declarator) ? 'function' : 'variable';
      return { type, owner, static: owner.namedChildren.some(child => child.type === 'storage_class_specifier' && child.text === 'static') };
    }
  };
  try {
    const visit = node => {
      if (++visited % 1024 === 0 && (visited > 150000 || Date.now() > deadline)) throw new Error('C coloring extraction budget exceeded');
      if (['comment', 'string_literal', 'char_literal', 'number_literal', 'system_lib_string'].includes(node.type)) return;
      if (['identifier', 'field_identifier', 'type_identifier', 'statement_identifier'].includes(node.type)) {
        const parent = node.parent, tag = ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(parent?.type);
        const namespace = tag ? 'tag' : node.type === 'field_identifier' ? 'field' : node.type === 'type_identifier' ? 'type' : 'value';
        const declared = definition(node);
        const start = node.startPosition, end = node.endPosition;
        if (start.row === end.row) {
          const token = { line: start.row, start: start.column, end: end.column, type: declared?.type ||
            (node.type === 'statement_identifier' ? 'label' : namespace === 'field' ? 'property' : namespace === 'type' || tag ? 'type'
              : parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === node.id ? 'function'
                : ['preproc_ifdef', 'preproc_defined'].includes(parent?.type) ? 'macro' : 'variable'),
          modifiers: declared ? ['declaration', ...(declared.static ? ['static'] : [])] : [] };
          tokens.push({ span: token, name: node.text, namespace, offset: node.startIndex, declared: Boolean(declared) });
          if (declared && namespace !== 'field') {
            const scope = scopeOf(declared.owner, declared.type === 'parameter');
            const key = `${namespace}:${node.text}`, list = bindings.get(key) || [];
            list.push({ type: declared.type, modifiers: token.modifiers.filter(value => value !== 'declaration'),
              start: node.startIndex, end: scope.endIndex, scope: scope.startIndex });
            bindings.set(key, list);
          }
        }
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(tree.rootNode);
    for (const token of tokens) {
      if (++visited % 1024 === 0 && Date.now() > deadline) throw new Error('C coloring binding budget exceeded');
      if (token.declared || token.namespace === 'field' || token.span.type === 'label') continue;
      let selected;
      for (const binding of bindings.get(`${token.namespace}:${token.name}`) || []) {
        if (binding.start <= token.offset && token.offset < binding.end &&
            (!selected || binding.scope > selected.scope || binding.scope === selected.scope && binding.start > selected.start)) selected = binding;
      }
      if (selected) { token.span.type = selected.type; token.span.modifiers = selected.modifiers; }
    }
    return tokens.map(token => token.span);
  } finally { tree.delete(); }
}

// Never cover even part of a token already classified by another provider.
function uncoveredSpans(local, semantic) {
  const lines = new Map();
  for (const span of semantic) {
    if (span.end <= span.start) continue;
    const list = lines.get(span.line) || []; list.push({ start: span.start, end: span.end }); lines.set(span.line, list);
  }
  for (const [line, values] of lines) {
    values.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const value of values) {
      const last = merged.at(-1);
      if (last && value.start <= last.end) last.end = Math.max(last.end, value.end); else merged.push(value);
    }
    lines.set(line, merged);
  }
  return local.filter(span => {
    const values = lines.get(span.line); if (!values) return true;
    let low = 0, high = values.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (values[mid].start < span.end) low = mid + 1; else high = mid;
    }
    return !low || values[low - 1].end <= span.start;
  });
}

module.exports = { cColorSpans, uncoveredSpans };
