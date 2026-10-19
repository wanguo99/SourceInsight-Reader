'use strict';
(() => {
  const api = acquireVsCodeApi(), get = id => document.getElementById(id);
  const query = get('query'), folder = get('folder'), results = get('results');
  let shortcuts = true, composing = false, session;
  const send = (action, extra = {}) => api.postMessage({ action, ...extra });
  const search = () => send('search', { query: query.value, folder: folder.value, matchCase: get('matchCase').checked, wholeWord: get('wholeWord').checked });
  get('search').addEventListener('click', search);
  query.addEventListener('compositionstart', () => { composing = true; });
  query.addEventListener('compositionend', () => { composing = false; });
  for (const name of ['folder', 'matchCase', 'wholeWord']) get(name).addEventListener('change', search);
  for (const action of ['refresh', 'cancel', 'next', 'previous', 'pageNext', 'pagePrevious']) get(action).addEventListener('click', () => send(action));
  document.addEventListener('switchResults', event => send('switchResults', { mode: event.detail }));
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && document.activeElement === query && !composing && !event.isComposing) { event.preventDefault(); search(); }
    if (event.key === 'F8' && shortcuts) { event.preventDefault(); send(event.shiftKey ? 'previous' : 'next'); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); query.focus(); query.select(); }
  });
  window.addEventListener('message', event => {
    const state = event.data; if (!Array.isArray(state.rows) || session !== undefined && state.session < session) return;
    shortcuts = state.shortcuts;
    if (session !== state.session || document.activeElement !== query) query.value = state.query;
    session = state.session;
    get('matchCase').checked = state.matchCase; get('wholeWord').checked = state.wholeWord;
    const previous = folder.value; folder.replaceChildren();
    for (const root of state.folders) { const option = document.createElement('option'); option.value = root.id; option.textContent = root.name; folder.append(option); }
    folder.value = state.folder || previous || state.folders[0]?.id || '';
    get('status').textContent = `${state.query ? `“${state.query}” · ` : ''}${state.status}${state.selected ? ` · ${state.selected}` : ''}`;
    get('page').textContent = `${state.page} / ${state.pages}`;
    get('pagePrevious').disabled = state.page <= 1; get('pageNext').disabled = state.page >= state.pages;
    get('next').disabled = get('previous').disabled = state.busy || state.stale || !state.rows.length;
    get('cancel').disabled = !state.busy;
    get('history').replaceChildren();
    for (const item of state.history) {
      const button = document.createElement('button'); button.className = 'history-item'; button.textContent = item.query; button.title = item.folder;
      if (item.query === state.query && item.folder === state.folder) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => send('history', { id: item.id })); get('history').append(button);
    }
    results.replaceChildren();
    const buttons = [];
    for (const row of state.rows) {
      const tr = document.createElement('tr');
      tr.addEventListener('click', event => {
        if (!state.busy && !state.stale && !event.target?.closest?.('button')) send(event.altKey ? 'preview' : 'open', { id: row.id });
      });
      if (row.selected) tr.className = 'selected';
      const owner = document.createElement('td'); owner.textContent = row.owner;
      const file = document.createElement('td'); file.textContent = `${row.path}:${row.line}:${row.column}`;
      const code = document.createElement('td'), button = document.createElement('button'); button.className = 'match';
      button.title = '点击或 Enter 定位源码；双击固定标签页；Alt+点击在 Context 预览'; button.disabled = state.stale || state.busy;
      const before = document.createElement('span'), matched = document.createElement('mark'), after = document.createElement('span');
      before.textContent = row.before; matched.textContent = row.matched; after.textContent = row.after;
      button.append(before, matched, after);
      button.addEventListener('click', event => send(event.altKey ? 'preview' : 'open', { id: row.id }));
        button.addEventListener('dblclick', () => send('pin', { id: row.id }));
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[buttons.indexOf(button) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
      });
      buttons.push(button); code.append(button); tr.append(owner, file, code); results.append(tr);
    }
    results.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  });
  send('ready'); query.focus();
})();
