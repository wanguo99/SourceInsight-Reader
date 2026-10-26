'use strict';

// Some recovered C trees corrupt the vendored WASM runtime when repeatedly
// queried through Node.parent. Record ancestry while walking down the tree;
// this also avoids repeated native root searches for every identifier.
function trackedTree() {
  const parents = new Map();
  return {
    parentOf: node => node && parents.get(node.id),
    childrenOf(node) {
      if (!node) return [];
      const children = node.namedChildren;
      for (const child of children) parents.set(child.id, node);
      return children;
    }
  };
}
module.exports = { trackedTree };
