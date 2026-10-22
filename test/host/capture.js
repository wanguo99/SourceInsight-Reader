'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Optional renderer screenshots: npm run test:host -- --capture-ui.
async function captureUi(name) {
  if (process.env.SOURCEINSIGHT_READER_CAPTURE_UI !== '1') return;
  const targets = await (await fetch('http://127.0.0.1:9327/json/list')).json();
  const target = targets.find(target => target.type === 'page' && target.url.includes('workbench'));
  if (!target) throw new Error('VS Code renderer debug target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer screenshot timed out')), 10000);
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    const file = path.resolve(__dirname, '../../dist', `${name}.png`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(result.data, 'base64'));
    console.log(`UI screenshot: ${file}`);
  } finally { socket.close(); }
}
module.exports = { captureUi };
