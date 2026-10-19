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
    get('icon-theme').textContent = state.iconCss || '';
    const list = document.createElement('div'), buttons = [];
    for (const row of state.rows) {
      const button = document.createElement('button'); button.className = `file-row${row.depth === 0 ? ' root' : ''}`; button.title = row.tooltip; button.fileKey = row.key; button.fileDepth = row.depth;
      button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(row.depth + 1));
      button.setAttribute('aria-selected', String(Boolean(row.selected)));
      if (row.type === 'directory') button.setAttribute('aria-expanded', String(row.expanded));
      const indent = document.createElement('span'); indent.className = 'indent';
      indent.style.backgroundSize = `${state.indent || 8}px 100%`;
      indent.style.width = `${Math.min(row.depth, 30) * (state.indent || 8)}px`;
      const arrow = document.createElement('span'); arrow.className = `arrow${row.type === 'directory' ? row.expanded ? ' expanded' : ' collapsed' : ''}`;
      arrow.setAttribute('aria-hidden', 'true');
      const icon = document.createElement('span'); icon.className = `file-icon ${row.type}`; icon.setAttribute('aria-hidden', 'true');
      if (row.icon?.uri) {
        const image = document.createElement('img'); image.src = row.icon.uri; image.alt = ''; icon.append(image);
      } else if (row.icon?.glyph) {
        icon.textContent = row.icon.glyph; icon.style.fontFamily = row.icon.family; icon.style.fontSize = row.icon.size;
        if (row.icon.color) icon.style.color = row.icon.color;
      } else if (row.type === 'file') { icon.className += ' generic-file'; }
      else if (!state.nativeIcons) { icon.className += ' generic-folder'; }
      else { icon.hidden = true; }
      const name = document.createElement('span'); name.className = 'name'; name.textContent = row.name;
      button.append(indent, arrow, icon, name);
      const action = row.type === 'directory' ? 'toggle' : 'open';
      button.addEventListener('click', () => api.postMessage({ action, id: row.id }));
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); buttons[buttons.indexOf(button) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
        if (row.type === 'directory' && ((event.key === 'ArrowRight' && !row.expanded) || (event.key === 'ArrowLeft' && row.expanded))) {
          event.preventDefault(); api.postMessage({ action: 'toggle', id: row.id });
        } else if (event.key === 'ArrowRight' && row.type === 'directory' && row.expanded) {
          event.preventDefault();
          const child = buttons[buttons.indexOf(button) + 1]; if (child?.fileDepth > row.depth) child.focus();
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          buttons.slice(0, buttons.indexOf(button)).reverse().find(parent => parent.fileDepth < row.depth)?.focus();
        }
        if (event.key === ' ') { event.preventDefault(); api.postMessage({ action: row.type === 'file' ? 'select' : 'toggle', id: row.id }); }
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
