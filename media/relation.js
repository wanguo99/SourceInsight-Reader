'use strict';
(() => {
  const api = window.sourceReaderApi;
  const element = id => document.getElementById(id);
  const tree = element('relation-tree');
  let selectedId;
  const send = (action, id = selectedId) => api.postMessage({ action: `relation.${action}`, id });
  for (const action of ['incoming', 'outgoing', 'lock', 'refresh', 'open', 'references', 'root', 'collapse'])
    element(`relation-${action}`).addEventListener('click', () => send(action));
  const select = (id, row) => {
    selectedId = id;
    for (const previous of tree.querySelectorAll('.selected')) { previous.classList.remove('selected'); previous.setAttribute('aria-selected', 'false'); }
    row.classList.add('selected'); row.setAttribute('aria-selected', 'true'); send('select', id);
  };
  window.addEventListener('message', event => {
    const state = event.data; if (state?.scope !== 'relation') return;
    if (state.focus) { tree.focus(); return; }
    if (state.selectionOnly) {
      selectedId = state.selectedId;
      for (const action of ['open', 'references', 'root']) element(`relation-${action}`).disabled = !selectedId;
      return;
    }
    if (!Array.isArray(state.rows)) return;
    const active = document.activeElement;
    const focusInTree = tree.contains(active), scroll = tree.scrollTop;
    selectedId = state.selectedId;
    element('relation-status').textContent = `${state.description || '请选择函数'}${state.truncated ? ' · 已达到显示上限，请折叠部分分支' : ''}`;
    element('relation-status').setAttribute('title', element('relation-status').textContent);
    element('relation-lock').textContent = state.locked ? '解锁' : '锁定';
    element('relation-lock').setAttribute('aria-pressed', String(state.locked));
    for (const direction of ['incoming', 'outgoing']) element(`relation-${direction}`).setAttribute('aria-pressed', String(state.direction === direction));
    for (const action of ['open', 'references', 'root']) element(`relation-${action}`).disabled = !selectedId;
    tree.replaceChildren();
    const render = rows => {
      const list = document.createElement('ul'); list.setAttribute('role', 'group');
      for (const node of rows) {
        const item = document.createElement('li');
        const row = document.createElement('div'); row.className = 'relation-row';
        row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', String(Boolean(node.selected)));
        row.setAttribute('tabindex', node.selected ? '0' : '-1');
        if (node.selected) row.classList.add('selected');
        if (node.expandable) row.setAttribute('aria-expanded', String(node.expanded));
        const twisty = document.createElement('button'); twisty.className = 'twisty';
        twisty.textContent = node.expandable ? node.expanded ? '▾' : '▸' : '·';
        twisty.disabled = !node.expandable; twisty.setAttribute('tabindex', '-1');
        twisty.setAttribute('aria-label', node.expanded ? '折叠' : '展开');
        twisty.addEventListener('click', event => { event.stopPropagation(); send('toggle', node.id); });
        const label = document.createElement('span'); label.textContent = node.label;
        const description = document.createElement('span'); description.className = 'relation-path'; description.textContent = node.description;
        row.append(twisty, label, description); row.title = `${node.label}\n${node.description}`;
        if (node.type !== 'message' && node.type !== 'sites') {
          row.addEventListener('click', () => { row.focus(); select(node.id, row); });
          row.addEventListener('dblclick', () => send('open', node.id));
        }
        row.addEventListener('keydown', event => {
          const rows = [...tree.querySelectorAll('.relation-row')]; const at = rows.indexOf(row);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); rows[at + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
          }
          if (event.key === 'ArrowRight' && node.expandable && !node.expanded || event.key === 'ArrowLeft' && node.expanded) {
            event.preventDefault(); send('toggle', node.id);
          }
          if (event.key === 'Enter') { event.preventDefault(); send('open', node.id); }
          if (event.key === ' ') { event.preventDefault(); select(node.id, row); }
        });
        item.append(row); if (node.children.length) item.append(render(node.children)); list.append(item);
      }
      return list;
    };
    tree.append(render(state.rows)); tree.scrollTop = scroll;
    if (focusInTree) (tree.querySelector('.selected') || tree).focus();
  });
  tree.addEventListener('keydown', event => {
    if (event.target === tree && (event.key === 'ArrowDown' || event.key === 'Enter')) { event.preventDefault(); tree.querySelector('.relation-row')?.focus(); }
  });
  const splitter = element('reading-splitter');
  let ratio = Number(api.getState()?.readingSplit) || 60;
  const resize = value => {
    ratio = Math.max(20, Math.min(80, value));
    document.body.style.gridTemplateColumns = `minmax(0, ${ratio}fr) 6px minmax(0, ${100 - ratio}fr)`;
    splitter.setAttribute('aria-valuenow', String(Math.round(ratio)));
  };
  resize(ratio);
  splitter.addEventListener('pointerdown', event => { splitter.setPointerCapture(event.pointerId); splitter.classList.add('dragging'); event.preventDefault(); });
  splitter.addEventListener('pointermove', event => {
    if (!splitter.hasPointerCapture(event.pointerId)) return;
    const box = document.body.getBoundingClientRect(); resize((event.clientX - box.left) * 100 / box.width);
  });
  const save = () => { splitter.classList.remove('dragging'); api.setState({ ...api.getState(), readingSplit: ratio }); };
  splitter.addEventListener('pointerup', save); splitter.addEventListener('pointercancel', save);
  splitter.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); resize(ratio + (event.key === 'ArrowLeft' ? -2 : 2)); save();
  });
  send('ready');
})();
