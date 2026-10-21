'use strict';
/** @template T @param {number} requestId @returns {import('./contracts').QueryState<T>} */
function idle(requestId = 0) { return Object.freeze({ status: 'idle', data: Object.freeze([]), requestId, revision: '' }); }
/** @template T @param {import('./contracts').QueryState<T>} previous @param {number} requestId @param {string} revision @param {boolean} preserveStale @returns {import('./contracts').QueryState<T>} */
function begin(previous, requestId, revision, preserveStale = false) {
  const valid = previous.status === 'stale' && !preserveStale ? idle(requestId) : previous;
  return Object.freeze({ ...valid, status: valid.data.length ? 'refreshing' : 'loading', requestId, revision });
}
/** @template T @param {import('./contracts').QueryState<T>} current @param {import('./contracts').QueryResult<T>} result @returns {import('./contracts').QueryState<T>} */
function settle(current, result) {
  const valid = result.status === 'ready' || result.status === 'empty';
  return Object.freeze({ requestId: current.requestId, revision: result.revision, result,
    status: valid ? result.data.length ? 'ready' : 'empty' : current.data.length ? 'retained' : 'failed',
    data: valid ? result.data : current.data, dataStale: valid ? false : Boolean(current.dataStale) });
}
/** @template T @param {import('./contracts').QueryState<T>} current @param {number} requestId @returns {import('./contracts').QueryState<T>} */
function stale(current, requestId) { return Object.freeze({ ...current, status: 'stale', dataStale: true, requestId }); }
module.exports = { idle, begin, settle, stale };
