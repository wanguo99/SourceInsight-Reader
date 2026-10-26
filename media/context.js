'use strict';
(() => {
  const api = window.readerBridge;
  window.sourceInsightReaderApi = api;
  let highlightUseF2 = false;
  const element = id => document.getElementById(id);
  const controlHover = pressed => element('code').setAttribute('data-control-hover', String(Boolean(pressed)));
  window.addEventListener('keydown', event => {
    controlHover(event.ctrlKey || event.metaKey);
    if ((event.key === 'F8' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) || event.key === 'F2' && highlightUseF2 || (event.ctrlKey || event.metaKey) && event.altKey && event.key?.toLowerCase() === 'h') {
      event.preventDefault(); api.postMessage({ action: 'highlightSymbol', symbol: window.getSelection()?.toString() || '' });
    }
  });
  window.addEventListener('keyup', event => controlHover(event.ctrlKey || event.metaKey));
  window.addEventListener('blur', () => controlHover(false));
  element('code').addEventListener('mousemove', event => controlHover(event.ctrlKey || event.metaKey));
  element('code').addEventListener('mouseleave', () => controlHover(false));
  for (const action of ['lock', 'refresh', 'open', 'pin', 'fullFunction', 'earlier', 'later', 'mode', 'rebuildIndex']) {
    element(action).addEventListener('click', () => api.postMessage({ action }));
  }
  element('back').addEventListener('click', () => api.postMessage({ action: 'editorBack' }));
  element('forward').addEventListener('click', () => api.postMessage({ action: 'editorForward' }));
  element('highlight').addEventListener('click', () => api.postMessage({ action: 'highlightSymbol', symbol: window.getSelection()?.toString() || '' }));
  let found = [], findIndex = -1;
  const find = () => {
    const query = element('context-find').value.toLocaleLowerCase();
    found = [...element('code').querySelectorAll('.line')].filter(row => query && row.sourceText?.toLocaleLowerCase().includes(query));
    for (const row of element('code').querySelectorAll('.line')) row.classList.toggle('find-match', found.includes(row));
    findIndex = -1; element('find-count').textContent = String(found.length);
  };
  element('context-find').addEventListener('input', find);
  element('find-next').addEventListener('click', () => { if (found.length) { findIndex = (findIndex + 1) % found.length; found[findIndex].scrollIntoView({ block: 'center' }); element('find-count').textContent = `${findIndex + 1}/${found.length}`; } });
  element('context-find').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); element('find-next').click(); } if (event.key === 'Escape') { element('context-find').value = ''; find(); element('code').focus(); } });
  element('context-pane').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); element('context-find').focus(); } });
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
  let candidateLabels = [], candidateButtons = [];
  api.onMessage( event => {
    const state = event.data;
    if (state?.scope === 'index') {
      element('rebuildIndex').disabled = Boolean(state.busy) || state.phase === 'disabled';
      element('rebuildIndex').textContent = state.busy ? (window.readerBridge?.t?.('索引处理中…') || '索引处理中…') : (window.readerBridge?.t?.('重建索引') || '重建索引');
      element('rebuildIndex').title = state.message || (window.readerBridge?.t?.('重新扫描当前工程并重建本地索引') || '重新扫描当前工程并重建本地索引');
      return;
    }
    if (state?.scope && state.scope !== 'context') return;
    highlightUseF2 = state.highlightUseF2 === true;
    element('highlight').setAttribute('aria-pressed', String(Boolean(state.highlightSymbol)));
    element('highlight').textContent = state.highlightSymbol ? `高亮: ${state.highlightSymbol}` : (window.readerBridge?.t?.('高亮') || '高亮');
    element('lock').textContent = state.locked ? (window.readerBridge?.t?.('解锁') || '解锁') : (window.readerBridge?.t?.('锁定') || '锁定');
    element('lock').setAttribute('aria-pressed', String(state.locked));
    element('open').disabled = !state.canOpen;
    element('earlier').disabled = state.locked || !state.canOpen;
    element('later').disabled = state.locked || !state.canOpen;
    // Native editor history is independent of Context content and preview lock.
    // The public API does not expose its availability; VS Code handles empty history.
    element('back').disabled = false;
    element('forward').disabled = false;
    element('status').textContent = state.status || '';
    element('status').setAttribute('title', state.status || '');
    const targetName = (state.path || '').split(/[\\/]/).pop();
    element('path').textContent = targetName ? `· ${targetName}` : '';
    element('path').setAttribute('title', state.path || '');
    element('metadata').hidden = state.candidates.length <= 1;
    const candidates = element('candidates');
    candidates.hidden = state.candidates.length <= 1;
    if (candidateLabels.length !== state.candidates.length || candidateLabels.some((label, index) => label !== state.candidates[index])) {
      candidateLabels = [...state.candidates]; candidateButtons = [];
      candidates.replaceChildren(); candidates.scrollTop = 0;
      state.candidates.forEach((label, index) => {
        const row = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.textContent = label; button.title = label;
        button.addEventListener('click', () => {
          if (!button.disabled) api.postMessage({ action: 'candidate', index, snapshot: button.candidateSnapshot });
        });
        button.addEventListener('keydown', event => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? candidateButtons.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1);
          candidateButtons[Math.max(0, Math.min(candidateButtons.length - 1, next))]?.focus();
        });
        candidateButtons.push(button); row.append(button); candidates.append(row);
      });
    }
    candidateButtons.forEach((button, index) => {
      button.disabled = Boolean(state.locked);
      button.candidateSnapshot = state.snapshot;
      button.setAttribute('aria-pressed', String(index === state.candidateIndex));
    });
    candidates.value = String(state.candidateIndex ?? -1);
    const code = element('code'), focusedKey = document.activeElement?.previewKey;
    const oldScroll = code.scrollTop, sameSnapshot = code.previewSnapshot === state.snapshot;
    code.previewSnapshot = state.snapshot;
    const links = [];
    code.className = state.sourceInsight ? 'source-insight' : '';
    code.replaceChildren();
    for (const line of state.lines || []) {
      const row = document.createElement('span');
      row.sourceText = line.text;
      row.className = line.active ? 'line active' : 'line';
      const number = document.createElement('span');
      number.className = 'number'; number.textContent = String(line.number);
      number.setAttribute('aria-hidden', 'true');
      row.append(number);
      const matches = window.sourceInsightSymbolMatches?.symbolRanges(line.text, state.highlightSymbol) || [];
      let offset = 0;
      for (const token of line.tokens || [{ text: line.text, kind: 'plain' }]) {
        const span = document.createElement('span');
        span.className = `token ${token.kind}${token.strong ? ' function-head' : ''}${token.emphasis ? ' ' + token.emphasis : ''}`;
        if (state.sourceInsight && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(token.foreground || '')) span.style.color = token.defaultText ? `var(--reader-context-foreground, ${token.foreground})` : token.foreground;
        if (state.sourceInsight) {
          if (typeof token.bold === 'boolean') span.style.fontWeight = token.bold ? 'bold' : 'inherit';
          if (typeof token.italic === 'boolean') span.style.fontStyle = token.italic ? 'italic' : 'normal';
          if (typeof token.underline === 'boolean' || typeof token.strikethrough === 'boolean') span.style.textDecoration = [token.underline ? 'underline' : '', token.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
          if (token.strong) span.style.fontWeight = token.emphasis === 'function-name' ? '900' : 'bold';
          if (token.emphasis === 'function-parameters') span.style.fontWeight = 'normal';
        }
        const end = offset + token.text.length;
        const header = line.includeRange && line.includeRange.start < end && line.includeRange.end > offset;
        if (header || ['plain', 'function', 'macro', 'property', 'type'].includes(token.kind) && /^[a-zA-Z_$][\w$]*$/.test(token.text)) {
          span.className += ' navigable';
          span.setAttribute('role', 'link'); span.setAttribute('tabindex', !state.locked && !links.length ? '0' : '-1');
          span.previewKey = `${line.number}:${offset}`; links.push(span);
          span.addEventListener('focus', () => { for (const link of links) link.setAttribute('tabindex', link === span ? '0' : '-1'); });
          const title = header ? '点击查看头文件' : '点击或 Ctrl+点击查看定义或声明，Shift+点击查看类型定义';
          span.setAttribute('title', window.readerBridge?.t?.(title) || title);
          const character = header ? Math.max(offset, line.includeRange.start) : offset;
          const navigate = event => {
            event.preventDefault(); event.stopPropagation();
            if (!state.locked) api.postMessage({ action: 'navigate', line: line.number - 1,
              character, snapshot: state.snapshot, type: !header && Boolean(event.shiftKey) });
          };
          span.addEventListener('click', navigate);
          span.addEventListener('keydown', event => {
            if (event.key === 'Enter') navigate(event);
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault(); event.stopPropagation();
              const index = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : links.indexOf(span) + (event.key === 'ArrowRight' ? 1 : -1);
              links[Math.max(0, Math.min(links.length - 1, index))]?.focus();
            }
          });
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
    if (sameSnapshot) code.scrollTop = oldScroll;
    else code.querySelector('.active')?.scrollIntoView({ block: 'center' });
    if (focusedKey) links.find(link => link.previewKey === focusedKey)?.focus();
    find();
  });
  api.postMessage({ action: 'ready' });
})();
