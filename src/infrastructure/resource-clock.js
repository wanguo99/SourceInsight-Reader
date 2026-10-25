'use strict';
// Intentional CPU throttling is not parser work and must not consume a file's
// extraction timeout. Ordinary callers retain the existing wall-clock budget.
function extractionClock(check) { return () => Date.now() - (check.suspendedMs?.() || 0); }
module.exports = { extractionClock };
