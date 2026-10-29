'use strict';
const { trackedTree } = require('./tree-traversal');
const { cSourceProjection } = require('./c-source-projection');
const { cDeclarationProjection } = require('./c-declaration-projection');
const { preprocessorFacts } = require('./preprocessor-facts');

// Single-file syntax roles only. Includes, macro expansion and conditional
// compilation require the language service; these spans never resolve symbols.
function cColorSpans(parser, source) {
  parser.setTimeoutMicros(1000000);
  const tree = parser.parse(cDeclarationProjection(cSourceProjection(source)).source);
  if (!tree) { parser.reset(); throw new Error('C coloring parse budget exceeded'); }
  const { parentOf, childrenOf } = trackedTree();
  const deadline = Date.now() + 1000, tokens = [], bindings = new Map();
  let visited = 0;
  const nameOf = node => {
    if (!node) return undefined;
    if (['identifier', 'field_identifier', 'type_identifier'].includes(node.type)) return node;
    return nameOf(node.childForFieldName('declarator') ||
      (node.type === 'parenthesized_declarator' ? childrenOf(node)[0] : undefined));
  };
  const isFunction = node => {
    for (let current = node; current; current = current.childForFieldName('declarator')) {
      if (current.type === 'function_declarator') return current.childForFieldName('declarator')?.type === 'identifier';
    }
    return false;
  };
  const scopeOf = (owner, parameter) => {
    for (let current = parentOf(owner); current; current = parentOf(current)) {
      if ((parameter ? ['function_definition', 'function_declarator'] : ['compound_statement', 'for_statement']).includes(current.type)) {
        if (parameter && current.type === 'function_declarator') {
          let fn = parentOf(current);
          while (fn && fn.type.endsWith('declarator')) fn = parentOf(fn);
          if (fn?.type === 'function_definition') return fn;
        }
        return current;
      }
    }
    return tree.rootNode;
  };
  const definition = node => {
    const parent = parentOf(node);
    if (!parent) return undefined;
    if (parent.type === 'enumerator' && parent.childForFieldName('name')?.id === node.id) return { type: 'enumMember', owner: parent };
    if (['preproc_def', 'preproc_function_def'].includes(parent.type) && parent.childForFieldName('name')?.id === node.id) return { type: 'macro', owner: parent };
    if (['struct_specifier', 'union_specifier', 'enum_specifier'].includes(parent.type) && parent.childForFieldName('name')?.id === node.id) {
      return parent.childForFieldName('body') ? { type: parent.type === 'enum_specifier' ? 'enum' : 'struct', owner: parent } : undefined;
    }
    for (let owner = parent; owner; owner = parentOf(owner)) {
      if (!['function_definition', 'declaration', 'parameter_declaration', 'field_declaration', 'type_definition'].includes(owner.type)) {
        if (!owner.type.endsWith('declarator')) break;
        continue;
      }
      const declarators = owner.childrenForFieldName('declarator');
      const declarator = declarators.find(value => nameOf(value)?.id === node.id);
      if (!declarator) return undefined;
      const type = owner.type === 'parameter_declaration' ? 'parameter' : owner.type === 'field_declaration' ? 'property'
        : owner.type === 'type_definition' ? 'type' : isFunction(declarator) ? 'function' : 'variable';
      return { type, owner, static: childrenOf(owner).some(child => child.type === 'storage_class_specifier' && child.text === 'static') };
    }
  };
  try {
    const visit = node => {
      if (++visited % 1024 === 0 && (visited > 150000 || Date.now() > deadline)) throw new Error('C coloring extraction budget exceeded');
      if (['comment', 'string_literal', 'char_literal', 'number_literal', 'system_lib_string'].includes(node.type)) return;
      if (['identifier', 'field_identifier', 'type_identifier', 'statement_identifier'].includes(node.type)) {
        const parent = parentOf(node), tag = ['struct_specifier', 'union_specifier', 'enum_specifier'].includes(parent?.type);
        const namespace = tag ? 'tag' : node.type === 'field_identifier' ? 'field' : node.type === 'type_identifier' ? 'type' : 'value';
        const declared = definition(node);
        const start = node.startPosition, end = node.endPosition;
        if (start.row === end.row) {
          const token = { line: start.row, start: start.column, end: end.column, type: declared?.type ||
            (node.type === 'statement_identifier' ? 'label' : namespace === 'field' ? 'property' : namespace === 'type' || tag ? 'type'
              : parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === node.id ? 'function'
                : ['preproc_ifdef', 'preproc_defined'].includes(parent?.type) ? 'macro' : 'variable'),
          unresolved: !declared, modifiers: declared ? ['declaration', ...(declared.static ? ['static'] : [])] : [] };
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
      for (const child of childrenOf(node)) visit(child);
    };
    visit(tree.rootNode);
    // Replacement text is a preproc_arg in the grammar, but its identifiers
    // still need neutral spans or confirmed project colors in both displays.
    const preprocessor = preprocessorFacts(source, 'color:');
    const starts = [0]; for (let at = 0; at < source.length; at++) if (source[at] === '\n') starts.push(at + 1);
    const offset = point => starts[point.line] + point.character;
    const byPosition = new Map(tokens.map(token => [`${token.span.line}:${token.span.start}`, token]));
    for (const parameter of preprocessor.locals) {
      const key = `value:${parameter.name}`, list = bindings.get(key) || [];
      list.push({ type: 'parameter', modifiers: [], start: offset(parameter.selectionRange.start), end: offset(parameter.scope.end), scope: offset(parameter.scope.start) });
      bindings.set(key, list);
    }
    const parameterPositions = new Map(preprocessor.locals.map(node => [`${node.selectionRange.start.line}:${node.selectionRange.start.character}`, node]));
    for (const value of preprocessor.tokens) {
      const start = value.range.start, end = value.range.end, key = `${start.line}:${start.character}`;
      if (start.line !== end.line) continue;
      let token = byPosition.get(key);
      const parameter = parameterPositions.get(key);
      if (token && !parameter) continue;
      if (!token) {
        token = { name: value.name, namespace: ['value','type','field','tag','label'][value.namespace], offset: offset(start), declared: false,
          span: { line: start.line, start: start.character, end: end.character, type: value.namespace === 2 ? 'property' : 'variable', unresolved: true, modifiers: [] } };
        tokens.push(token); byPosition.set(key, token);
      }
      if (parameter) { token.declared = true; token.span = { ...token.span, type: 'parameter', unresolved: false, modifiers: ['declaration'] }; }
    }
    for (const token of tokens) {
      if (++visited % 1024 === 0 && Date.now() > deadline) throw new Error('C coloring binding budget exceeded');
      if (token.declared || token.namespace === 'field' || token.span.type === 'label') continue;
      let selected;
      for (const binding of bindings.get(`${token.namespace}:${token.name}`) || []) {
        if (binding.start <= token.offset && token.offset < binding.end &&
            !(binding.type === 'macro' && preprocessor.undefs.some(event => !event.conditional && event.name === token.name && offset(event.range.start) > binding.start && offset(event.range.start) < token.offset)) &&
            (!selected || binding.scope > selected.scope || binding.scope === selected.scope && binding.start > selected.start)) selected = binding;
      }
      if (selected) { token.span.type = selected.type; token.span.modifiers = selected.modifiers; token.span.unresolved = false; }
    }
    return tokens.map(token => token.span).sort((a, b) => a.line - b.line || a.start - b.start);
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

// Both displays use the same precedence. Indexed source roles, corrected
// export references and unknown identifiers override provider guesses.
function combinedColorSpans(local, semantic) {
  const preferred = local;
  const peers = new Map(semantic.map(span => [`${span.line}:${span.start}:${span.end}`, span]));
  const localSpans = preferred.map(span => {
    const peer = peers.get(`${span.line}:${span.start}:${span.end}`);
    const modifiers = !span.unresolved && peer?.type === span.type
      ? [...new Set([...(span.modifiers || []), ...(peer.modifiers || []).filter(value => !['declaration', 'definition', 'static'].includes(value))])]
      : span.modifiers || [];
    return { ...span, modifiers, localColor: true };
  });
  return [...uncoveredSpans(semantic, preferred), ...localSpans];
}
module.exports = { cColorSpans, uncoveredSpans, combinedColorSpans };
