'use strict';
/** @param {unknown} value @returns {value is Record<string, any>} */
function object(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
/** @param {unknown} value @returns {value is import('./contracts').Position} */
function position(value) { return object(value) && Number.isSafeInteger(value.line) && value.line >= 0 && Number.isSafeInteger(value.character) && value.character >= 0; }
/** @param {unknown} value @returns {value is import('./contracts').Range} */
function range(value) { return object(value) && position(value.start) && position(value.end) &&
  (value.end.line > value.start.line || value.end.line === value.start.line && value.end.character >= value.start.character); }
/** @param {unknown} value @returns {boolean} */
function uri(value) { try { return Boolean(value && (typeof value === 'string' || object(value) && typeof value.toString === 'function') && /^[a-z][a-z\d+.-]*:/i.test(String(value))); } catch { return false; } }
/** @param {unknown} value @returns {boolean} */
function summary(value) { return object(value) && ['files', 'functions', 'calls'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0); }
/** @param {unknown} value @returns {boolean} */
function indexMessage(value) {
  if (!object(value)) return false;
  if (typeof value.diagnostic === 'string') return value.diagnostic.length <= 8192;
  if (object(value.progress)) return (value.progress.id === undefined || Number.isSafeInteger(value.progress.id)) &&
    (value.progress.stage === undefined || ['files', 'relations'].includes(value.progress.stage)) &&
    Number.isSafeInteger(value.progress.done) && value.progress.done >= 0 && Number.isSafeInteger(value.progress.total) && value.progress.total >= value.progress.done;
  if (object(value.snapshot)) return Array.isArray(value.snapshot.uris) && value.snapshot.uris.every(uri) && summary(value.snapshot.summary);
  return Number.isSafeInteger(value.id) && value.id > 0 && (value.error === undefined || typeof value.error === 'string' && value.error.length <= 8192);
}
module.exports = { object, position, range, uri, summary, indexMessage };
