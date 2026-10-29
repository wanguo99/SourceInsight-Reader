'use strict';
// VS Code SymbolKind values whose Relation edges describe uses, not calls.
function isUsageKind(kind) { return [7, 9, 12, 13, 21, 22, 25].includes(kind); }
module.exports = { isUsageKind };
