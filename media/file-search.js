'use strict';
(() => {
  const api = acquireVsCodeApi(), get = id => document.getElementById(id);
  const query = get('query'), results = get('results');
  let composing = false, sent;
  const search = () => {
    if (composing || sent === query.value) return;
    sent = query.value; api.postMessage({ action: 'search', query: query.value });
  };
  query.addEventListener('input', search);
  query.addEventListener('compositionstart', () => { composing = true; });
  query.addEventListener('compositionend', () => { composing = false; search(); });
  query.addEventListener('keydown', event => {
    if (event.key === 'Escape') { query.value = ''; search(); }
    if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); results.querySelector('button')?.focus(); }
  });
  get('clear').addEventListener('click', () => { query.value = ''; search(); query.focus(); });
  get('refresh').addEventListener('click', () => api.postMessage({ action: 'refresh' }));
  window.addEventListener('message', event => {
    const state = event.data;
    if (state.focusSearch) { query.focus(); return; }
    if (document.activeElement !== query) { query.value = state.query; sent = state.query; }
    get('status').textContent = state.status;
    const list = document.createElement('div'), buttons = [];
    for (const row of state.rows) {
      const button = document.createElement('button'); button.className = 'result'; button.title = row.tooltip;
      const name = document.createElement('span'); name.className = 'name'; name.textContent = row.name;
      const path = document.createElement('span'); path.className = 'path'; path.textContent = row.path;
      button.append(name, path);
      button.addEventListener('click', () => api.postMessage({ action: 'open', id: row.id }));
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); buttons[buttons.indexOf(button) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
        if (event.key === 'Escape') { event.preventDefault(); query.focus(); }
      });
      buttons.push(button); list.append(button);
    }
    results.replaceChildren(list);
  });
  api.postMessage({ action: 'ready' });
})();
