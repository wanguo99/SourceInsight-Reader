'use strict';
(() => {
  const api = acquireVsCodeApi();
  const element = id => document.getElementById(id);
  for (const action of ['lock', 'refresh', 'back', 'forward', 'open', 'earlier', 'later']) {
    element(action).addEventListener('click', () => api.postMessage({ action }));
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
    element('lock').textContent = state.locked ? '解锁' : '锁定';
    element('lock').setAttribute('aria-pressed', String(state.locked));
    element('open').disabled = !state.canOpen;
    element('earlier').disabled = state.locked || !state.canOpen;
    element('later').disabled = state.locked || !state.canOpen;
    element('back').disabled = state.locked || !state.canBack;
    element('forward').disabled = state.locked || !state.canForward;
    element('status').textContent = state.status || '';
    element('path').textContent = state.path || '';
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
    code.replaceChildren();
    for (const line of state.lines || []) {
      const row = document.createElement('span');
      row.className = line.active ? 'line active' : 'line';
      const number = document.createElement('span');
      number.className = 'number'; number.textContent = String(line.number);
      number.setAttribute('aria-hidden', 'true');
      row.append(number);
      let offset = 0;
      for (const token of line.tokens || [{ text: line.text, kind: 'plain' }]) {
        const span = document.createElement('span');
        span.className = `token ${token.kind}`;
        const end = offset + token.text.length;
        if (['plain', 'function'].includes(token.kind) && /^[a-zA-Z_$][\w$]*$/.test(token.text)) {
          span.className += ' navigable';
          span.setAttribute('role', 'link'); span.setAttribute('tabindex', state.locked ? '-1' : '0');
          span.setAttribute('title', '点击查看定义/类型，Shift+点击查看类型定义');
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
        const startMark = Math.max(offset, line.start), endMark = Math.min(end, line.end);
        if (startMark < endMark) {
          span.append(document.createTextNode(token.text.slice(0, startMark - offset)));
          const mark = document.createElement('mark'); mark.textContent = token.text.slice(startMark - offset, endMark - offset);
          span.append(mark, document.createTextNode(token.text.slice(endMark - offset)));
        } else span.textContent = token.text;
        row.append(span); offset = end;
      }
      code.append(row);
    }
    code.querySelector('.active')?.scrollIntoView({ block: 'center' });
  });
  api.postMessage({ action: 'ready' });
})();
