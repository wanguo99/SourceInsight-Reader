'use strict';
(() => {
  const api = window.readerBridge, get = id => document.getElementById(id);
  const search = get('search'), tree = get('symbols');
  get('more')?.addEventListener('click', () => api.postMessage({ action: 'more' }));
  let composing = false, lastQuery;
  const filter = () => {
    if (composing || lastQuery === search.value) return;
    lastQuery = search.value; api.postMessage({ action: 'filter', query: search.value });
  };
  tree.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.focus(); }
  });
  search.addEventListener('input', filter);
  search.addEventListener('compositionstart', () => { composing = true; });
  search.addEventListener('compositionend', () => { composing = false; filter(); });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { search.value = ''; filter(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); tree.querySelector('.symbol-row')?.focus(); }
  });
  get('clear').addEventListener('click', () => { search.value = ''; filter(); search.focus(); });
  api.onMessage( event => {
    const state = event.data;
    if (state.focusSearch) { search.focus(); return; }
    const scrollTop = tree.scrollTop, activeKey = document.activeElement?.symbolKey;
    get('filename').textContent = state.filename; get('filename').title = state.path;
    // Preserve an input in progress until its matching reply arrives.
    if (document.activeElement !== search) search.value = state.query;
    if (document.activeElement !== search) lastQuery = state.query;
    get('summary').textContent = `${state.summary}${state.truncated ? ' · 还有结果，可继续显示或搜索' : ''}`;
    if (get('more')) get('more').hidden = !state.truncated;
    const buttons = [], fragment = document.createElement('div');
    for (const row of state.rows) {
      const line = document.createElement('div'); line.className = 'symbol-line';
      const indent = document.createElement('span'); indent.textContent = '  '.repeat(Math.min(row.depth, 30)); indent.className = 'indent';
      const twisty = document.createElement('button'); twisty.className = 'twisty';
      twisty.textContent = row.expandable ? row.expanded ? '▾' : '▸' : '';
      twisty.disabled = !row.expandable; twisty.tabIndex = -1;
      twisty.setAttribute('aria-label', row.expanded ? (window.readerBridge?.t?.('折叠') || '折叠') : (window.readerBridge?.t?.('展开') || '展开'));
      twisty.addEventListener('click', () => api.postMessage({ action: 'toggle', id: row.id }));
      const button = document.createElement('button'); button.className = 'symbol-row'; button.title = row.tooltip; button.symbolKey = row.key;
      button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', String(row.depth + 1));
      button.setAttribute('aria-selected', String(row.selected));
      if (row.expandable) button.setAttribute('aria-expanded', String(row.expanded));
      const label = document.createElement('span'); label.className = 'symbol-name'; label.textContent = row.label;
      if (row.icon) {
        const icon = document.createElement('img'); icon.className = 'symbol-icon'; icon.src = row.icon;
        icon.alt = ''; icon.title = row.category; icon.setAttribute('aria-hidden', 'true');
        button.append(icon);
      }
      button.append(label);
      button.addEventListener('click', event => api.postMessage({ action: event.altKey ? 'preview' : 'open', id: row.id }));
      button.addEventListener('contextmenu', event => { event.preventDefault(); api.postMessage({ action: 'menu', id: row.id }); });
      button.addEventListener('keydown', event => {
        if (['Enter', ' '].includes(event.key)) { event.preventDefault(); api.postMessage({ action: event.key === 'Enter' ? 'open' : 'preview', id: row.id }); }
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); buttons[buttons.indexOf(button) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
        if (row.expandable && ((event.key === 'ArrowLeft' && row.expanded) || (event.key === 'ArrowRight' && !row.expanded))) {
          event.preventDefault(); api.postMessage({ action: 'toggle', id: row.id });
        }
      });
      buttons.push(button); line.append(indent, twisty, button); fragment.append(line);
    }
    if (!state.rows.length) { const empty = document.createElement('p'); empty.textContent = state.message; fragment.append(empty); }
    tree.replaceChildren(fragment); tree.scrollTop = scrollTop;
    if (activeKey) buttons.find(button => button.symbolKey === activeKey)?.focus();
    if (state.reveal) tree.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });
  api.postMessage({ action: 'ready' });
})();
