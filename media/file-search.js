'use strict';
(() => {
  const api = window.readerBridge, get = id => document.getElementById(id);
  const query = get('query'), results = get('results');
  get('more')?.addEventListener('click', () => api.postMessage({ action: 'more' }));
  get('manage-directories').addEventListener('click', () => api.postMessage({ action: 'manageDirectories' }));
  let composing = false, sent, iconCss, anchor;
  const selected = new Set();
  const fonts = new Map();
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
  api.onMessage( event => {
    const state = event.data;
    if (get('more')) get('more').hidden = !state.hasMore;
    if (state.focusSearch) { query.focus(); return; }
    get('manage-directories').textContent = '已屏蔽（' + (state.excludedCount || 0) + '）';
    const visibleKeys = new Set(state.rows.map(row => row.key));
    for (const key of selected) if (!visibleKeys.has(key)) selected.delete(key);
    if (anchor && !visibleKeys.has(anchor)) anchor = undefined;
    if (state.reveal) { selected.clear(); for (const row of state.rows) if (row.selected) selected.add(row.key); }
    const activeKey = document.activeElement?.fileKey, scrollTop = results.scrollTop;
    if (document.activeElement !== query) { query.value = state.query; sent = state.query; }
    query.title = state.status || '';
    const nextCss = state.iconCss || '';
    if (iconCss !== nextCss) {
      iconCss = nextCss; get('icon-theme').textContent = nextCss; fonts.clear();
    }
    const list = document.createElement('div'), buttons = [];
    const updateSelection = () => buttons.forEach(button => button.setAttribute('aria-selected', String(selected.has(button.fileKey))));
    const select = (row, event = {}) => {
      if (event.shiftKey && anchor) {
        if (!event.ctrlKey && !event.metaKey) selected.clear();
        const first = state.rows.findIndex(item => item.key === anchor), last = state.rows.indexOf(row);
        for (let i = Math.min(first, last); i <= Math.max(first, last); i++) if (state.rows[i]) selected.add(state.rows[i].key);
      } else {
        if (!event.ctrlKey && !event.metaKey) selected.clear();
        if ((event.ctrlKey || event.metaKey) && selected.has(row.key)) selected.delete(row.key); else selected.add(row.key);
        anchor = row.key;
      }
      updateSelection();
    };
    for (const row of state.rows) {
      const button = document.createElement('button'); button.className = `file-row${row.depth === 0 ? ' root' : ''}`; button.title = row.tooltip; button.fileKey = row.key; button.fileDepth = row.depth;
      const context = () => button.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'entry', targetId: row.id,
        targetIds: JSON.stringify(state.rows.filter(item => selected.has(item.key)).map(item => item.id)), preventDefaultContextMenuItems: true }));
      button.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'entry', targetId: row.id, preventDefaultContextMenuItems: true }));
      button.addEventListener('contextmenu', () => {
        if (!selected.has(row.key)) select(row);
        context();
      });
      button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(row.depth + 1));
      button.setAttribute('aria-selected', String(selected.has(row.key)));
      if (row.type === 'directory') button.setAttribute('aria-expanded', String(row.expanded));
      const indent = document.createElement('span'); indent.className = 'indent';
      indent.style.backgroundSize = `${state.indent || 8}px 100%`;
      indent.style.width = `${Math.min(row.depth, 30) * (state.indent || 8)}px`;
      const arrow = document.createElement('span'); arrow.className = `arrow${row.type === 'directory' ? row.expanded ? ' expanded' : ' collapsed' : ''}`;
      arrow.setAttribute('aria-hidden', 'true');
      const icon = document.createElement('span'); icon.className = `file-icon ${row.type}`; icon.setAttribute('aria-hidden', 'true');
      const generic = () => {
        icon.replaceChildren(); icon.textContent = '';
        icon.className = `file-icon ${row.type} generic-${row.type === 'file' ? 'file' : 'folder'}`;
        icon.style.fontFamily = ''; icon.style.fontSize = ''; icon.style.color = '';
      };
      if (row.icon?.uri) {
        const image = document.createElement('img'); image.src = row.icon.uri; image.alt = '';
        image.addEventListener('error', generic); icon.append(image);
      } else if (row.icon?.glyph) {
        // Private-use characters become tofu squares in the default font. Keep
        // a real file/folder icon until the requested font is actually loaded.
        generic();
        const key = `${row.icon.family}:${row.icon.glyph}`;
        if (!fonts.has(key)) fonts.set(key, document.fonts?.load
          ? document.fonts.load(`16px "${row.icon.family}"`, row.icon.glyph).then(faces => faces.length > 0, () => false)
          : Promise.resolve(false));
        fonts.get(key).then(loaded => {
          if (!loaded) return;
          icon.className = `file-icon ${row.type}`; icon.textContent = row.icon.glyph;
          icon.style.fontFamily = row.icon.family; icon.style.fontSize = row.icon.size;
          if (row.icon.color) icon.style.color = row.icon.color;
        });
      } else if (row.type === 'file' || !state.nativeIcons) { generic(); }
      else { icon.hidden = true; }
      const name = document.createElement('span'); name.className = 'name'; name.textContent = row.name;
      button.append(indent, arrow, icon, name);
      const action = row.type === 'directory' ? 'toggle' : 'open';
      button.addEventListener('click', (event = {}) => {
        select(row, event);
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) api.postMessage({ action, id: row.id });
      });
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next = buttons[buttons.indexOf(button) + (event.key === 'ArrowDown' ? 1 : -1)];
          if (next && event.shiftKey) select(state.rows[buttons.indexOf(next)], event);
          next?.focus();
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
        if (event.key === ' ') { event.preventDefault(); select(row, event); if (event.shiftKey || event.ctrlKey || event.metaKey) return; api.postMessage({ action: row.type === 'file' ? 'select' : 'toggle', id: row.id }); }
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
