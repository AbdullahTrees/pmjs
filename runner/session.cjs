'use strict';

const sessionProcess = process;
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const WORKER_MONITOR_PROTOCOL = 1;
function writeEmergency(error) {
  try {
    const description = error && (error.stack || error.message) || String(error);
    const prefix = new Date().toISOString() + ' ERROR [pmjs] ';
    fs.writeSync(2, String(description).replace(/\r\n?/g, '\n').split('\n')
      .map(line => prefix + line).join('\n') + '\n');
  } catch (_) {}
}
// Observation only; unlike uncaughtException this does not change Node's exit policy.
sessionProcess.on('uncaughtExceptionMonitor', writeEmergency);
sessionProcess.once('disconnect', () => {
  writeEmergency(new Error('Supervisor connection lost; stopping session'));
  sessionProcess.exit(1);
});
try { fs.writeSync(2, '[pmjs] worker-start pid=' + sessionProcess.pid + '\n'); } catch (_) {}
require('./logging.cjs').installConsoleLogging();
const { run } = require('./index.cjs');
let captureMemorySnapshot = null;
function sendDiagnosticsReady() {
  try { sessionProcess.send({ type: 'pmjs-worker-diagnostics-ready',
    protocol: WORKER_MONITOR_PROTOCOL }, () => {}); } catch (_) {}
}
sessionProcess.on('message', message => {
  if (message && message.type === 'pmjs-worker-monitor-probe') {
    if (captureMemorySnapshot) sendDiagnosticsReady();
    return;
  }
  if (message && message.type === 'pmjs-memory-snapshot-request') {
    const startedAt = performance.now();
    const elapsed = () => Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
    const status = line => {
      try { fs.writeSync(2, '[pmjs] memory-breakdown-' + line + ' requestId=' +
        message.requestId + ' duration_ms=' + elapsed() + '\n'); } catch (_) {}
    };
    status('capture-start');
    if (!captureMemorySnapshot) {
      status('capture-unavailable');
      sessionProcess.send({ type: 'pmjs-memory-snapshot', requestId: message.requestId,
        error: 'snapshot handler is not ready' }, () => {});
      return;
    }
    try {
      const snapshot = captureMemorySnapshot(message);
      sessionProcess.send({ type: 'pmjs-memory-snapshot', requestId: message.requestId,
        supervisorMemory: message.supervisorMemory || null, snapshot }, error => {
        status(error ? 'capture-send-error' : 'capture-complete');
      });
    } catch (error) {
      status('capture-error');
      sessionProcess.send({ type: 'pmjs-memory-snapshot', requestId: message.requestId,
        error: String(error && error.message || error).slice(0, 512) }, () => {});
    }
  }
});
try { sessionProcess.send({ type: 'pmjs-worker-monitor-online',
  protocol: WORKER_MONITOR_PROTOCOL }, () => {}); } catch (_) {}
sessionProcess.once('message', async options => {
  try {
    const result = await run({ ...options, supervised: true }, {
      onMemorySnapshot: handler => {
        captureMemorySnapshot = handler;
        if (typeof handler === 'function') sendDiagnosticsReady();
      }
    });
    sessionProcess.send({ type: 'pmjs-session-complete', reload: !!(result && result.reload) }, error => {
      if (error) writeEmergency(error);
      sessionProcess.exit(error ? 1 : 0);
    });
  } catch (error) {
    writeEmergency(error);
    sessionProcess.exit(1);
  } finally {
    captureMemorySnapshot = null;
  }
});
