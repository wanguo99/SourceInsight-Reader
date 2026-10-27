'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Optional renderer screenshots: npm run test:host -- --capture-ui.
async function captureUi(name, prepare) {
  if (process.env.SOURCEINSIGHT_READER_CAPTURE_UI !== '1') return;
  const targets = await (await fetch('http://127.0.0.1:9327/json/list')).json();
  const target = targets.find(target => target.type === 'page' && target.url.includes('workbench'));
  if (!target) throw new Error('VS Code renderer debug target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0, cleanup;
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const receive = event => {
      const message = JSON.parse(String(event.data)); if (message.id !== id) return;
      clearTimeout(timer); socket.removeEventListener('message', receive);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    };
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Renderer request timed out: ' + method)); }, 10000);
    socket.addEventListener('message', receive); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    cleanup = await prepare?.(send);
    const result = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.resolve(__dirname, '../../dist', `${name}.png`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(result.data, 'base64'));
    console.log(`UI screenshot: ${file}`);
  } finally { try { await cleanup?.(); } finally { socket.close(); } }
}
// Inspect webview DOM in its own frame; cross-origin iframe access is never
// disabled in the product. This helper is only used by renderer integration tests.
async function webviewContext(send, elementId) {
  const targets = await send('Target.getTargets');
  const sessions = [undefined];
  for (const target of targets.targetInfos.filter(target => target.type === 'iframe' && target.url.includes('vscode-webview'))) {
    const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    sessions.push(attached.sessionId);
  }
  for (const sessionId of sessions) {
    const tree = await send('Page.getFrameTree', {}, sessionId);
    const frames = [], walk = node => { frames.push(node.frame.id); for (const child of node.childFrames || []) walk(child); };
    walk(tree.frameTree);
    for (const frameId of frames) {
      try {
        const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'sourceinsight-ui-test' }, sessionId);
        const evaluate = async expression => {
          const value = await send('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true }, sessionId);
          if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
          return value.result.value;
        };
        if (await evaluate(`Boolean(document.getElementById(${JSON.stringify(elementId)}))`)) return evaluate;
      } catch { /* Another target owns cross-origin or already detached frames. */ }
    }
  }
  throw new Error('Webview frame not found: ' + elementId);
}
module.exports = { captureUi, webviewContext };
