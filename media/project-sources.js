'use strict';
(() => {
  const api = window.readerBridge, get = id => document.getElementById(id), t = value => api.t(value);
  const send = payload => { get('status').textContent = t('正在处理…'); api.postMessage(payload); };
  for (const id of ['reload', 'clear', 'save', 'start', 'close']) get(id).addEventListener('click', () => send({ action: id }));
  for (const mode of ['compilation', 'selected', 'workspace']) get('mode-' + mode).addEventListener('change', () => send({ action: 'mode', mode }));
  get('choose-database').addEventListener('click', () => send({ action: 'chooseDatabase' }));
  get('add-mapping').addEventListener('click', () => send({ action: 'addMapping' }));
  const checkbox = (input, mode, id, action) => {
    let shift = false;
    input.addEventListener('click', event => { shift = Boolean(event.shiftKey); });
    input.addEventListener('change', () => {
      send(shift ? { action: 'range', mode, id, type: input.checked }
        : action === 'toggle' ? { action, id, type: input.checked } : { action, id });
      shift = false;
    });
  };
  const button = (text, action, id) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text;
    node.addEventListener('click', () => send({ action, id })); return node;
  };
  api.onMessage(event => {
    const state = event.data; if (state.scope !== 'projectSources') return;
    const focus = document.activeElement?.id, treeScroll = get('tree').scrollTop, selectedScroll = get('selected').scrollTop;
    for (const mode of ['compilation', 'selected', 'workspace']) get('mode-' + mode).checked = (state.mode || 'selected') === mode;
    get('compilation-options').hidden = state.mode !== 'compilation'; get('database-path').textContent = state.databaseDisplay || state.compilationDatabase || t('尚未选择编译数据库');
    get('source-picker').hidden = state.mode === 'compilation'; get('compilation-summary').hidden = state.mode !== 'compilation';
    get('path-mappings').replaceChildren(...(state.pathMappings || []).map((item, index) => {
      const row = document.createElement('p'), label = document.createElement('span');
      label.textContent = item.from + ' → ' + item.to + ' ';
      const remove = button(t('移除'), 'removeMapping', String(index)); remove.disabled = state.starting;
      row.className = 'mapping-row'; row.append(label, remove); return row;
    }));
    get('status').textContent = state.status;
    get('summary').textContent = (state.whole ? t('整个工作区已选中') : `${t('已选条目')}：${state.selected.length}`) + ' · ' + t('取消勾选即可移除');
    get('clear').hidden = state.mode !== 'selected'; get('selection-hint').hidden = state.mode !== 'selected';
    for (const id of ['mode-compilation', 'mode-selected', 'mode-workspace', 'choose-database', 'add-mapping', 'reload', 'clear']) get(id).disabled = state.starting;
    get('save').disabled = !state.dirty || state.starting;
    get('start').disabled = state.starting;
    const rows = state.rows.map(row => {
      if (row.more) { const more = button(t('加载更多条目'), 'more', row.id); more.className = 'more'; return more; }
      const line = document.createElement('div'); line.className = 'tree-row'; line.style.paddingLeft = `${row.depth * 20}px`;
      line.setAttribute('role', 'treeitem'); line.setAttribute('aria-level', String(row.depth + 1));
      line.setAttribute('aria-checked', row.partial ? 'mixed' : String(row.checked));
      if (row.directory) line.setAttribute('aria-expanded', String(row.expanded));
      const arrow = button(row.directory ? row.expanded ? '▾' : '▸' : '', 'expand', row.id);
      arrow.className = 'arrow'; arrow.disabled = !row.directory; arrow.id = 'expand-' + row.id;
      arrow.setAttribute('aria-label', (row.expanded ? t('折叠目录') : t('展开目录')) + ' ' + row.name);
      const label = document.createElement('label'); label.title = row.path;
      const check = document.createElement('input'); check.type = 'checkbox'; check.id = 'check-' + row.id;
      check.checked = row.checked; check.indeterminate = row.partial; check.disabled = row.disabled || state.starting;
      checkbox(check, 'tree', row.id, 'toggle');
      const name = document.createElement('span'); name.textContent = row.name + (row.directory ? '/' : '');
      label.append(check, name); line.append(arrow, label); return line;
    });
    get('tree').replaceChildren(...rows);
    const selected = state.selected.map(row => {
      const label = document.createElement('label'); label.className = 'selected-row'; label.title = row.path;
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true; check.disabled = state.starting; check.id = 'remove-' + row.id;
      checkbox(check, 'selected', row.id, 'remove');
      const text = document.createElement('span'); text.textContent = (row.label || row.path) + (row.directory ? '/' : '');
      label.append(check, text); return label;
    });
    get('selected').replaceChildren(...selected);
    if (focus) get(focus)?.focus();
    get('tree').scrollTop = treeScroll; get('selected').scrollTop = selectedScroll;
  });
  api.postMessage({ action: 'ready' });
})();
