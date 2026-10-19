'use strict';
(() => {
  const api = acquireVsCodeApi();
  window.sourceInsightInspiredApi = api;
  const element = id => document.getElementById(id);
  const controlHover = pressed => element('code').setAttribute('data-control-hover', String(Boolean(pressed)));
  window.addEventListener('keydown', event => {
    controlHover(event.ctrlKey || event.metaKey);
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'h') {
      event.preventDefault(); api.postMessage({ action: 'highlightSymbol', symbol: window.getSelection()?.toString() || '' });
    }
  });
  window.addEventListener('keyup', event => controlHover(event.ctrlKey || event.metaKey));
  window.addEventListener('blur', () => controlHover(false));
  element('code').addEventListener('mousemove', event => controlHover(event.ctrlKey || event.metaKey));
  element('code').addEventListener('mouseleave', () => controlHover(false));
  for (const action of ['lock', 'refresh', 'back', 'forward', 'open', 'earlier', 'later', 'mode']) {
    element(action).addEventListener('click', () => api.postMessage({ action }));
  }
  // Handle mouse side buttons once, on release, and suppress native webview navigation.
  for (const eventName of ['mousedown', 'mouseup', 'auxclick']) {
    element('code').addEventListener(eventName, event => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault(); event.stopPropagation();
      if (eventName === 'mouseup') api.postMessage({ action: event.button === 3 ? 'back' : 'forward' });
    });
  }
  element('code').addEventListener('dblclick', () => api.postMessage({ action: 'open' }));
  element('code').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); api.postMessage({ action: 'open' }); }
    if (event.altKey && event.key === ',') { event.preventDefault(); api.postMessage({ action: 'back' }); }
    if (event.altKey && event.key === '.') { event.preventDefault(); api.postMessage({ action: 'forward' }); }
  });
  element('candidates').addEventListener('change', event => {
    api.postMessage({ action: 'candidate', index: Number(event.target.value) });
  });
  window.addEventListener('message', event => {
    const state = event.data;
    if (state?.scope === 'relation') return;
    element('lock').textContent = state.locked ? '解锁' : '锁定';
    element('lock').setAttribute('aria-pressed', String(state.locked));
    element('open').disabled = !state.canOpen;
    element('earlier').disabled = state.locked || !state.canOpen;
    element('later').disabled = state.locked || !state.canOpen;
    element('back').disabled = state.locked || !state.canBack;
    element('forward').disabled = state.locked || !state.canForward;
    element('status').textContent = state.status || '';
    element('status').setAttribute('title', state.status || '');
    const targetName = (state.path || '').split(/[\\/]/).pop();
    element('path').textContent = targetName ? `· ${targetName}` : '';
    element('path').setAttribute('title', state.path || '');
    element('metadata').hidden = state.candidates.length <= 1;
    const candidates = element('candidates');
    candidates.replaceChildren();
    candidates.hidden = state.candidates.length <= 1;
    candidates.disabled = state.locked;
    const placeholder = document.createElement('option');
    placeholder.textContent = '选择定义候选…'; placeholder.value = '-1'; placeholder.disabled = true;
    candidates.append(placeholder);
    state.candidates.forEach((label, index) => {
      const option = document.createElement('option');
      option.textContent = label; option.value = String(index); candidates.append(option);
    });
    candidates.value = String(state.candidateIndex ?? -1);
    const code = element('code');
    code.className = state.sourceInsight ? 'source-insight' : '';
    code.replaceChildren();
    for (const line of state.lines || []) {
      const row = document.createElement('span');
      row.className = line.active ? 'line active' : 'line';
      const number = document.createElement('span');
      number.className = 'number'; number.textContent = String(line.number);
      number.setAttribute('aria-hidden', 'true');
      row.append(number);
      const matches = window.sourceInsightSymbolMatches?.symbolRanges(line.text, state.highlightSymbol) || [];
      let offset = 0;
      for (const token of line.tokens || [{ text: line.text, kind: 'plain' }]) {
        const span = document.createElement('span');
        span.className = `token ${token.kind}`;
        const end = offset + token.text.length;
        if (['plain', 'function', 'macro', 'property', 'type'].includes(token.kind) && /^[a-zA-Z_$][\w$]*$/.test(token.text)) {
          span.className += ' navigable';
          span.setAttribute('role', 'link'); span.setAttribute('tabindex', state.locked ? '-1' : '0');
          span.setAttribute('title', '点击或 Ctrl+点击查看定义/类型，Shift+点击查看类型定义');
          const character = offset;
          const navigate = event => {
            event.preventDefault(); event.stopPropagation();
            if (!state.locked) api.postMessage({ action: 'navigate', line: line.number - 1,
              character, snapshot: state.snapshot, type: Boolean(event.shiftKey) });
          };
          span.addEventListener('click', navigate);
          span.addEventListener('keydown', event => { if (event.key === 'Enter') navigate(event); });
          span.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); });
        }
        const boundaries = new Set([offset, end]);
        for (const range of [...matches, { start: line.start, end: line.end }]) {
          if (range.start < end && range.end > offset) {
            boundaries.add(Math.max(offset, range.start)); boundaries.add(Math.min(end, range.end));
          }
        }
        const points = [...boundaries].sort((a, b) => a - b);
        for (let i = 0; i < points.length - 1; i++) {
          const start = points[i], stop = points[i + 1];
          const fixed = matches.some(range => range.start <= start && range.end >= stop);
          const target = line.start <= start && line.end >= stop;
          const text = token.text.slice(start - offset, stop - offset);
          if (fixed || target) {
            const mark = document.createElement('mark'); mark.textContent = text;
            if (fixed) mark.className = 'symbol-match';
            span.append(mark);
          } else span.append(document.createTextNode(text));
        }
        row.append(span); offset = end;
      }
      code.append(row);
    }
    code.querySelector('.active')?.scrollIntoView({ block: 'center' });
  });
  api.postMessage({ action: 'ready' });
})();
