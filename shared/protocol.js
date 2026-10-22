'use strict';
(function (root) {
  const VERSION = 1;
  const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  function envelope(session, sequence, kind, payload) { return { version: VERSION, session, sequence, kind, payload }; }
  function valid(value, session, kind) {
    return object(value) && value.version === VERSION && value.session === session && value.kind === kind &&
      Number.isSafeInteger(value.sequence) && value.sequence > 0 && object(value.payload);
  }
  function action(value, allowed) {
    if (!object(value) || typeof value.action !== 'string' || !allowed.includes(value.action)) return false;
    if (Object.keys(value).length > 16) return false;
    for (const [key, field] of Object.entries(value)) {
      if (key === 'action') continue;
      if (['id', 'mode', 'folder', 'symbol', 'query'].includes(key) && (typeof field !== 'string' || field.length > (key === 'query' ? ['appearanceSave', 'settingsSave', 'settingsSaveReload'].includes(value.action) ? 32768 : 1000 : 4096))) return false;
      if (['line', 'character', 'snapshot', 'index', 'generation'].includes(key) && (!Number.isSafeInteger(field) || field < 0)) return false;
      if (['matchCase', 'wholeWord', 'type'].includes(key) && typeof field !== 'boolean') return false;
      if (!['id', 'mode', 'folder', 'symbol', 'query', 'line', 'character', 'snapshot', 'index', 'generation', 'matchCase', 'wholeWord', 'type'].includes(key)) return false;
    }
    return true;
  }
  const api = { VERSION, envelope, valid, action };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SourceInsightProtocol = api;
})(globalThis);
