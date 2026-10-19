'use strict';
(() => {
  const api = acquireVsCodeApi();
  const filter = document.getElementById('filter'), results = document.getElementById('results');
  let timer, shortcuts = true;
  const send = (action, extra = {}) => api.postMessage({ action, ...extra });
  for (const action of ['refresh', 'history', 'previous', 'next', 'clear'])
    document.getElementById(action).addEventListener('click', () => send(action));
  filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => send('filter', { query: filter.value }), 150); });
  document.addEventListener('switchResults', event => send('switchResults', { mode: event.detail }));
  document.addEventListener('keydown', event => {
    if (event.key === 'F8' && shortcuts) { event.preventDefault(); send(event.shiftKey ? 'previous' : 'next'); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); filter.focus(); filter.select(); }
    if (event.key === 'Escape' && document.activeElement === filter) { clearTimeout(timer); filter.value = ''; send('filter', { query: '' }); }
    if (event.key === 'Enter' && document.activeElement === filter) { event.preventDefault(); results.querySelector('button.reference')?.focus(); }
  });
  window.addEventListener('message', event => {
    const state = event.data;
    if (!state || !Array.isArray(state.groups)) return;
    shortcuts = state.shortcuts;
    if (document.activeElement !== filter) filter.value = state.query;
    document.getElementById('status').textContent = state.status;
    document.getElementById('source').textContent = state.source;
    results.replaceChildren();
    for (const group of state.groups) {
      const section = document.createElement('section'), title = document.createElement('h2');
      title.textContent = `${group.path} (${group.total})`; section.append(title);
      for (const row of group.rows) {
        const button = document.createElement('button'); button.className = 'reference';
        button.textContent = `${row.line}:${row.column}  ${row.snippet || ''}`;
        button.title = '点击或 Enter 打开源码；双击固定标签页；Alt+点击在 Context 预览';
        if (row.selected) button.classList.add('selected');
        button.addEventListener('click', event => send(event.altKey ? 'preview' : 'open', { id: row.id }));
        button.addEventListener('dblclick', () => send('pin', { id: row.id }));
        section.append(button);
      }
      if (group.more) {
        const more = document.createElement('button'); more.textContent = '显示更多';
        more.addEventListener('click', () => send('more', { id: group.id })); section.append(more);
      }
      results.append(section);
    }
    results.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  });
  send('ready'); filter.focus();
})();
