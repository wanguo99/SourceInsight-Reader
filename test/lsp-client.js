'use strict';
const { spawn } = require('node:child_process');

class LspClient {
  constructor(command, args, cwd) {
    this.process = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.errors = '';
    this.closed = false;
    this.process.on('close', () => { this.closed = true; });
    this.process.stdin.on('error', error => this.rejectAll(error));
    this.process.stderr.on('data', chunk => { this.errors += chunk.toString(); });
    this.process.stdout.on('data', chunk => this.receive(chunk));
    this.process.on('error', error => this.rejectAll(error));
    this.process.on('exit', (code, signal) => this.rejectAll(new Error(`LSP exited: ${code ?? signal}\n${this.errors}`)));
  }
  send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.process.stdin.write(body);
  }
  notify(method, params) { this.send({ method, params }); }
  request(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`LSP timeout: ${method}\n${this.errors}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params });
    });
  }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString());
      if (!match) throw new Error('Invalid LSP response framing');
      const length = Number(match[1]);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      if (message.id !== undefined && message.method) {
        this.send({ id: message.id, result: null });
      } else if (this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
        else entry.resolve(message.result);
      } else if (message.method) this.onNotification?.(message.method, message.params);
    }
  }
  rejectAll(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  async close() {
    if (this.closed) return;
    const closed = new Promise(resolve => this.process.once('close', resolve));
    try { await this.request('shutdown', null); this.notify('exit'); }
    finally { this.process.kill(); await closed; }
  }
}

module.exports = { LspClient };
