'use strict';
(() => {
  const native = acquireVsCodeApi(), protocol = window.SourceInsightProtocol;
  const session = document.querySelector('meta[name="reader-session"]').content;
  let sent = 0, received = 0; const listeners = new Set();
  window.addEventListener('message', event => {
    const message = event.data;
    if (!protocol.valid(message, session, 'state') || message.sequence <= received) return;
    received = message.sequence;
    if (message.payload.scope === 'appearanceStyles') {
      const style = document.getElementById('reader-appearance'); if (style) style.textContent = message.payload.css;
      window.dispatchEvent(new Event('reader-appearance-changed')); return;
    }
    for (const listener of listeners) listener({ data: message.payload });
  });
  window.readerBridge = Object.freeze({
    postMessage: payload => native.postMessage(protocol.envelope(session, ++sent, 'action', Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)))),
    onMessage: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getState: () => native.getState(), setState: value => native.setState(value)
  });
})();
