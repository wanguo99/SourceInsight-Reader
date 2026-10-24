'use strict';
const { spawn } = require('node:child_process');
function runBounded(command, args, { timeoutMs = 600000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options, detached: process.platform !== 'win32' });
    let timedOut = false, killer;
    const stop = signal => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
        else process.kill(-child.pid, signal);
      } catch { child.kill(signal); }
    };
    const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); killer = setTimeout(() => stop('SIGKILL'), 1000); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      // The group may still contain a stuck grandchild after its parent exits.
      if (!timedOut) clearTimeout(killer);
      if (timedOut) reject(Object.assign(new Error(`Process exceeded ${timeoutMs}ms: ${command}`), { code: 'timeout' }));
      else if (code !== 0) reject(new Error(`Process exited ${code || signal}: ${command}`)); else resolve();
    });
  });
}
module.exports = { runBounded };
