'use strict';

// SourceInsight-Reader visual vocabulary, with identity kept independent
// of translated labels and provider-specific symbol details.
function symbolIcon(node) {
  if (['include', 'macro', 'struct', 'union', 'typedef', 'enum'].includes(node.category)) return node.category;
  const icons = { 0: 'file', 1: 'namespace', 2: 'namespace', 3: 'namespace', 4: 'type',
    5: 'function', 6: 'member', 7: 'member', 8: 'function', 9: 'enum', 10: 'type',
    11: 'function', 12: 'variable', 13: 'constant', 21: 'enum-member', 22: 'struct', 25: 'typedef' };
  return icons[node.kind] || 'symbol';
}
module.exports = { symbolIcon };
