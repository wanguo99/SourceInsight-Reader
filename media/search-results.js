'use strict';
(() => {
  const api = window.readerBridge, get = id => document.getElementById(id);
  const query = get('query'), folder = get('folder'), results = get('results');
  let shortcuts = true, composing = false, session, mode = 'text', filterTimer;
  const send = (action, extra = {}) => api.postMessage({ action, mode, ...(session === undefined ? {} : { generation: session }), ...extra });
  const search = () => send('search', { query: query.value, folder: folder.value, matchCase: get('matchCase').checked, wholeWord: get('wholeWord').checked, regex: get('regex').checked, multiline: get('multiline').checked });
  get('lookupTextTab').addEventListener('click', () => send('switchResults', { mode: 'text' }));
  get('lookupReferencesTab').addEventListener('click', () => send('switchResults', { mode: 'references' }));
  get('clear').addEventListener('click', () => send('clear'));
  get('history').addEventListener('click', () => { if (mode === 'references') send('history'); else get('historyPane').hidden = !get('historyPane').hidden; });
  query.addEventListener('input', () => { if (mode === 'references') { clearTimeout(filterTimer); filterTimer = setTimeout(search, 150); } });
  get('search').addEventListener('click', search);
  query.addEventListener('compositionstart', () => { composing = true; });
  query.addEventListener('compositionend', () => { composing = false; });
  for (const name of ['folder', 'matchCase', 'wholeWord', 'regex', 'multiline']) get(name).addEventListener('change', search);
  for (const action of ['refresh', 'cancel', 'next', 'previous', 'pageNext', 'pagePrevious']) get(action).addEventListener('click', () => send(action));
  document.addEventListener('switchResults', event => send('switchResults', { mode: event.detail }));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { query.value = ''; search(); }
    if (event.key === 'Enter' && !event.shiftKey && document.activeElement === query && !composing && !event.isComposing) { event.preventDefault(); search(); }
    if (event.key === 'F8' && shortcuts) { event.preventDefault(); send(event.shiftKey ? 'previous' : 'next'); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); query.focus(); query.select(); }
  });
  api.onMessage( event => {
    const state = event.data; if (!Array.isArray(state.rows)) return;
    const changedMode = mode !== state.mode; if (changedMode) clearTimeout(filterTimer); mode = state.mode;
    get('lookupTextTab').setAttribute('aria-pressed', String(mode === 'text'));
    get('lookupReferencesTab').setAttribute('aria-pressed', String(mode === 'references'));
    for (const id of ['folder', 'caseLabel', 'wordLabel', 'regexLabel', 'multilineLabel', 'historyPane']) get(id).hidden = mode !== 'text';
    query.placeholder = mode === 'text' ? (window.readerBridge?.t?.('输入字符，Enter 检索') || '输入字符，Enter 检索') : (window.readerBridge?.t?.('筛选文件路径或源码') || '筛选文件路径或源码');
    shortcuts = state.shortcuts;
    if (changedMode || session !== state.generation || document.activeElement !== query) query.value = state.query;
    session = state.generation;
    get('matchCase').checked = state.matchCase; get('wholeWord').checked = state.wholeWord;
    get('regex').checked = state.regex; get('multiline').checked = state.multiline;
    const previous = folder.value; folder.replaceChildren();
    for (const root of state.folders) { const option = document.createElement('option'); option.value = root.id; option.textContent = root.name; folder.append(option); }
    folder.value = state.folder || previous || state.folders[0]?.id || '';
    get('status').textContent = `${state.query ? `“${state.query}” · ` : ''}${state.status}${state.selected ? ` · ${state.selected}` : ''}`;
    get('page').textContent = `${state.page} / ${state.pages}`;
    get('pagePrevious').disabled = state.page <= 1; get('pageNext').disabled = state.page >= state.pages;
    get('next').disabled = get('previous').disabled = state.busy || state.stale || !state.rows.length;
    get('cancel').disabled = !state.busy;
    get('historyList').replaceChildren();
    for (const item of state.history) {
      const button = document.createElement('button'); button.className = 'history-item'; button.textContent = item.query; button.title = item.folder;
      if (item.query === state.query && item.folder === state.folder) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => send('history', { id: item.id })); get('historyList').append(button);
    }
    const activeId = document.activeElement?.resultKey;
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
      button.resultKey = row.id; button.tabIndex = row.selected || activeId === row.id || !buttons.length && !activeId ? 0 : -1;
      button.addEventListener('focus', () => { for (const item of buttons) item.tabIndex = item === button ? 0 : -1; });
      button.title = (window.readerBridge?.t?.('点击或 Enter 定位源码；双击固定标签页；Alt+点击在 Context 预览') || '点击或 Enter 定位源码；双击固定标签页；Alt+点击在 Context 预览'); button.disabled = state.stale || state.busy;
      const before = document.createElement('span'), matched = document.createElement('mark'), after = document.createElement('span');
      before.textContent = row.before; matched.textContent = row.matched; after.textContent = row.after;
      button.append(before, matched, after);
      button.addEventListener('click', event => send(event.altKey ? 'preview' : 'open', { id: row.id }));
      button.addEventListener('dblclick', () => send('pin', { id: row.id }));
      button.addEventListener('keydown', event => {
        if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[buttons.indexOf(button) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
      });
      buttons.push(button); code.append(button); tr.append(owner, file, code); results.append(tr);
    }
    results.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    if (activeId) buttons.find(button => button.resultKey === activeId)?.focus();
  });
  send('ready'); query.focus();
})();
