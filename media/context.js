'use strict';
(() => {
  const api = acquireVsCodeApi();
  const element = id => document.getElementById(id);
  for (const action of ['lock', 'refresh', 'back', 'forward', 'open']) {
    element(action).addEventListener('click', () => api.postMessage({ action }));
  }
  element('candidates').addEventListener('change', event => {
    api.postMessage({ action: 'candidate', index: Number(event.target.value) });
  });
  window.addEventListener('message', event => {
    const state = event.data;
    element('lock').textContent = state.locked ? '解锁' : '锁定';
    element('lock').setAttribute('aria-pressed', String(state.locked));
    element('open').disabled = !state.canOpen;
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
      if (line.start >= 0 && line.end > line.start) {
        row.append(document.createTextNode(line.text.slice(0, line.start)));
        const mark = document.createElement('mark');
        mark.textContent = line.text.slice(line.start, line.end); row.append(mark);
        row.append(document.createTextNode(line.text.slice(line.end)));
      } else row.append(document.createTextNode(line.text));
      row.append(document.createTextNode('\n')); code.append(row);
    }
    code.querySelector('.active')?.scrollIntoView({ block: 'center' });
  });
  api.postMessage({ action: 'ready' });
})();
