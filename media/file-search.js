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
  results.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); query.focus(); }
  });
  window.addEventListener('message', event => {
    const state = event.data;
    if (state.focusSearch) { query.focus(); return; }
    const activeKey = document.activeElement?.fileKey, scrollTop = results.scrollTop;
    if (document.activeElement !== query) { query.value = state.query; sent = state.query; }
    query.title = state.status || '';
    const list = document.createElement('div'), buttons = [];
    for (const row of state.rows) {
      const button = document.createElement('button'); button.className = 'file-row'; button.title = row.tooltip; button.fileKey = row.key;
      button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(row.depth + 1));
      button.setAttribute('aria-selected', String(Boolean(row.selected)));
      if (row.type === 'directory') button.setAttribute('aria-expanded', String(row.expanded));
      const indent = document.createElement('span'); indent.className = 'indent'; indent.textContent = '  '.repeat(Math.min(row.depth, 30));
      const icon = document.createElement('span'); icon.className = `icon ${row.type}`;
      icon.textContent = row.type === 'directory' ? row.expanded ? '▾' : '▸' : '·';
      const name = document.createElement('span'); name.className = 'name'; name.textContent = row.name;
      button.append(indent, icon, name);
      const action = row.type === 'directory' ? 'toggle' : 'open';
      button.addEventListener('click', () => api.postMessage({ action, id: row.id }));
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); buttons[buttons.indexOf(button) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
        if (row.type === 'directory' && ((event.key === 'ArrowRight' && !row.expanded) || (event.key === 'ArrowLeft' && row.expanded))) {
          event.preventDefault(); api.postMessage({ action: 'toggle', id: row.id });
        }
        if (event.key === 'Escape') { event.preventDefault(); query.focus(); }
      });
      buttons.push(button); list.append(button);
    }
    results.replaceChildren(list); results.scrollTop = scrollTop;
    if (activeKey) buttons.find(button => button.fileKey === activeKey)?.focus();
    if (state.reveal) results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });
  api.postMessage({ action: 'ready' });
})();
