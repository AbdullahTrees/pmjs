'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');

async function runSupervised(prepare, { worker = path.join(__dirname, 'session.cjs') } = {}) {
  let active = null, signal = null;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map(signals.map(name => [name, () => {
    signal = name;
    if (active) active.kill(name);
  }]));
  for (const [name, handler] of handlers) process.on(name, handler);
  try {
    for (;;) {
      const options = typeof prepare === 'function' ? await prepare() : prepare;
      if (signal) return { code: null, signal };
      const result = await new Promise((resolve, reject) => {
        let reload = false;
        active = fork(worker, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
        active.on('message', message => { if (message && message.type === 'pmjs-session-complete') reload = message.reload === true; });
        active.once('error', reject);
        active.once('close', (code, terminated) => { active = null; resolve({ code, signal: terminated, reload }); });
        active.send(options);
      });
      if (signal) return { code: result.code, signal };
      if (result.code !== 0 || result.signal || !result.reload) return result;
    }
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
}

module.exports = { runSupervised };
