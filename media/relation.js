'use strict';
(() => {
  const api = window.sourceInsightReaderApi;
  const element = id => document.getElementById(id);
  const tree = element('relation-tree');
  let selectedId, lastState, graphSession, primaryRow, graphSignature;
  const send = (action, id = selectedId) => api.postMessage({ action: `relation.${action}`, id });
  for (const action of ['incoming', 'outgoing', 'lock', 'refresh', 'verify', 'open', 'references', 'root', 'collapse', 'view', 'more'])
    element(`relation-${action}`).addEventListener('click', () => send(action));
  const select = (id, row, notify = true) => {
    selectedId = id;
    const attribute = row => row.className.includes('relation-graph-node') ? 'aria-pressed' : 'aria-selected';
    for (const previous of tree.querySelectorAll('.selected')) { previous.classList.remove('selected'); previous.setAttribute(attribute(previous), 'false'); }
    row.classList.add('selected'); row.setAttribute(attribute(row), 'true'); if (notify) send('select', id);
  };
  const svgElement = (name, attributes = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    return node;
  };
  const renderGraph = state => {
    const graph = state.graph;
    if (!graph?.root) {
      const empty = document.createElement('p'); empty.className = 'relation-graph-empty';
      empty.textContent = graph?.message || '请选择函数'; tree.replaceChildren(empty); primaryRow = undefined; graphSignature = undefined; return;
    }
    const session = `${graph.root.label}:${graph.root.description}`;
    const newRoot = session !== graphSession;
    graphSession = session;
    const scrollTop = tree.scrollTop, scrollLeft = tree.scrollLeft;
    const fontSize = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(tree).fontSize) || 13 : 13;
    const signature = JSON.stringify([graph.root, graph.incoming, graph.outgoing, tree.clientWidth, selectedId, fontSize]);
    if (signature === graphSignature && tree.querySelector('.relation-graph-board')) {
      updateGraphTitles(graph);
      return;
    }
    graphSignature = signature;
    const layout = window.SourceInsightReaderRelationLayout.layoutGraph(graph.incoming, graph.root, graph.outgoing, tree.clientWidth || 720, fontSize);
    const board = document.createElement('div'); board.className = 'relation-graph-board';
    board.style.width = `${layout.width}px`; board.style.height = `${layout.height}px`;
    const svg = svgElement('svg', { width: layout.width, height: layout.height, viewBox: `0 0 ${layout.width} ${layout.height}`, 'aria-hidden': 'true' });
    svg.setAttribute('class', 'relation-graph-edges');
    const defs = svgElement('defs'), marker = svgElement('marker', {
      id: 'sourceinsight-reader-relation-arrow', viewBox: '0 0 6 6', refX: 5, refY: 3, markerWidth: 6, markerHeight: 6, orient: 'auto'
    });
    marker.append(svgElement('path', { d: 'M 0 0 L 6 3 L 0 6 Z', class: 'relation-graph-arrow' })); defs.append(marker); svg.append(defs);
    for (const edge of layout.edges) svg.append(svgElement('path', {
      d: edge.d, class: 'relation-graph-edge', 'marker-end': 'url(#sourceinsight-reader-relation-arrow)'
    }));
    board.append(svg);
    const header = document.createElement('div'); header.className = 'relation-graph-header';
    header.style.height = `${Math.max(29, layout.headHeight + 5)}px`;
    layout.columns.forEach((x, index) => {
      const title = document.createElement('div'); title.className = 'relation-graph-title';
      title.style.left = `${x}px`; header.append(title);
    });
    board.append(header);
    const buttons = [];
    for (const geometry of layout.nodes) {
      const node = geometry.item;
      const card = document.createElement('div'); card.className = `relation-graph-card${geometry.column === 1 ? ' graph-current' : ''}${node.unresolved ? ' graph-unresolved' : ''}`;
      card.style.left = `${geometry.x}px`; card.style.top = `${geometry.y}px`;
      card.style.width = `${geometry.width}px`; card.style.height = `${geometry.height}px`;
      if (node.type === 'message') {
        const text = document.createElement('div'); text.className = 'relation-graph-message'; text.textContent = node.label;
        card.append(text); board.append(card); continue;
      }
      const row = document.createElement('button'); row.className = 'relation-row relation-graph-node';
      row.style.height = `${layout.headHeight}px`;
      row.setAttribute('type', 'button'); row.setAttribute('aria-label', `${node.label}，${node.description}`);
      row.setAttribute('aria-pressed', String(node.id === selectedId || Boolean(node.selected)));
      if (node.id === selectedId || node.selected) row.classList.add('selected');
      const name = document.createElement('span'); name.className = 'relation-graph-name'; name.textContent = node.label;
      row.title = `${node.label}\n${node.unresolved ? '未解析 · ' : ''}${node.description}${node.detail ? `\n${node.detail}` : ''}`;
      const icon = document.createElement('span'); icon.className = 'relation-symbol-icon'; icon.textContent = 'ƒ'; icon.setAttribute('aria-hidden', 'true');
      row.append(icon, name); row.addEventListener('click', () => { row.focus(); select(node.id, row); });
      row.addEventListener('dblclick', () => send('open', node.id));
      row.addEventListener('keydown', event => {
        const at = buttons.findIndex(button => button.row === row);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); buttons[at + (event.key === 'ArrowDown' ? 1 : -1)]?.row.focus();
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); const next = geometry.column + (event.key === 'ArrowLeft' ? -1 : 1);
          buttons.find(button => button.column === next)?.row.focus();
        }
        if (event.key === 'Enter') { event.preventDefault(); send('open', node.id); }
        if (event.key === ' ') { event.preventDefault(); select(node.id, row); }
      });
      buttons.push({ row, column: geometry.column });
      if (geometry.column === 1) primaryRow = row;
      if (!node.siteCount) row.style.height = '100%';
      card.append(row);
      if (node.siteCount) {
        for (const [index, site] of (node.siteLines || []).entries()) {
          const button = document.createElement('button'); button.className = 'relation-graph-site'; button.type = 'button';
          button.style.height = `${layout.siteHeight}px`; button.style.lineHeight = `${layout.siteHeight}px`;
          button.textContent = `${index + 1}. line ${site.line}`; button.title = `${site.file}:${site.line}`;
          button.setAttribute('aria-label', `查看 ${node.label} 的调用位置 ${site.file}:${site.line}`);
          button.addEventListener('click', () => { select(node.id, row, false); api.postMessage({ action: 'relation.site', id: node.id, index }); });
          card.append(button);
        }
        if (!node.siteLines?.length || node.siteCount > 3) {
          const sites = document.createElement('button'); sites.className = 'relation-graph-sites'; sites.textContent = `全部调用点（${node.siteCount}）`;
          sites.style.height = `${layout.siteHeight}px`; sites.style.lineHeight = `${layout.siteHeight}px`;
          sites.setAttribute('type', 'button'); sites.setAttribute('aria-label', `预览 ${node.label} 的 ${node.siteCount} 处调用位置`);
          sites.addEventListener('click', () => { select(node.id, row); send('sites', node.id); }); card.append(sites);
        }
      }
      board.append(card);
    }
    tree.replaceChildren(board);
    updateGraphTitles(graph);
    tree.scrollTop = newRoot ? Math.max(0, layout.center.y + layout.center.height / 2 - (tree.clientHeight || 200) / 2) : scrollTop;
    tree.scrollLeft = newRoot ? Math.max(0, layout.center.x + layout.center.width / 2 - (tree.clientWidth || 720) / 2) : scrollLeft;
  };
  function updateGraphTitles(graph) {
    const statusLabel = status => status?.loading ? ' · 更新中' : status?.state === 'retained' ? ' · 保留结果' : status?.backend === 'local' ? ' · 本地 C' : status?.backend === 'languageService' ? ' · 语言服务' : '';
    const titles = [`调用者（${graph.incomingCount}）${statusLabel(graph.incomingStatus)}`, '当前函数', `调用函数（${graph.outgoingCount}）${statusLabel(graph.outgoingStatus)}`];
    tree.querySelectorAll('.relation-graph-title').forEach((title, index) => {
      title.textContent = titles[index];
      title.title = index === 0 ? graph.incomingStatus?.note || '' : index === 2 ? graph.outgoingStatus?.note || '' : graph.message || '';
    });
  }
  api.onMessage( event => {
    const state = event.data;
    if (state?.scope === 'index') {
      const status = element('relation-index-status');
      status.hidden = state.phase === 'idle';
      status.textContent = state.message || '';
      status.title = state.message || '';
      status.setAttribute('aria-busy', String(Boolean(state.busy)));
      status.classList.toggle('index-error', state.phase === 'error');
      return;
    }
    if (state?.scope !== 'relation') return;
    if (state.focus) { tree.focus(); return; }
    if (state.selectionOnly) {
      selectedId = state.selectedId;
      for (const action of ['open', 'references', 'root']) element(`relation-${action}`).disabled = !selectedId;
      return;
    }
    if (!Array.isArray(state.rows)) return;
    lastState = state;
    const active = document.activeElement;
    const focusInTree = tree.contains(active), scroll = tree.scrollTop;
    selectedId = state.selectedId;
    element('relation-status').textContent = `${state.description || '请选择函数'}${state.truncated
      ? ' · 还有结果，可继续显示；深层分支可重新设根' : ''}`;
    element('relation-more').hidden = !state.truncated;
    element('relation-status').setAttribute('title', element('relation-status').textContent);
    element('relation-lock').textContent = state.locked ? '解锁' : '锁定';
    element('relation-lock').setAttribute('aria-pressed', String(state.locked));
    for (const direction of ['incoming', 'outgoing']) element(`relation-${direction}`).setAttribute('aria-pressed', String(state.direction === direction));
    for (const action of ['open', 'references', 'root']) element(`relation-${action}`).disabled = !selectedId;
    const graphMode = state.viewMode === 'horizontalGraph';
    for (const action of ['incoming', 'outgoing', 'collapse']) element(`relation-${action}`).hidden = graphMode;
    element('relation-view').textContent = graphMode ? '横向图 ▾' : '列表 ▾';
    tree.className = graphMode ? 'relation-graph' : '';
    tree.setAttribute('role', graphMode ? 'group' : 'tree');
    tree.setAttribute('aria-label', graphMode ? '调用者、当前函数与调用函数，横向一层关系图' : '调用关系树形列表');
    if (graphMode) {
      renderGraph(state);
      if (focusInTree) (tree.querySelector('.selected') || primaryRow || tree).focus();
      return;
    }
    graphSession = undefined; primaryRow = undefined; graphSignature = undefined;
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
    if (event.target === tree && (event.key === 'ArrowDown' || event.key === 'Enter')) { event.preventDefault(); (primaryRow || tree.querySelector('.relation-row'))?.focus(); }
  });
  window.addEventListener('reader-appearance-changed', () => { if (lastState?.viewMode === 'horizontalGraph') renderGraph(lastState); });
  if (typeof ResizeObserver !== 'undefined') {
    let width = 0;
    new ResizeObserver(() => {
      if (lastState?.viewMode !== 'horizontalGraph' || width === tree.clientWidth) return;
      width = tree.clientWidth; renderGraph(lastState);
    }).observe(tree);
  }
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
