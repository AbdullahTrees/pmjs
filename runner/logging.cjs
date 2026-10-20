'use strict';

const { format } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const HostDate = Date;
let launcherLog = null;
let launcherBytes = 0;
const LAUNCHER_MAX_BYTES = 1024 * 1024;
const PLUGIN_REPEAT_WINDOW_MS = 1000;
const MAX_PENDING_PLUGIN_LOGS = 128;
const pendingPluginLogs = new Map();
let pluginLogTimer = null;
let overloadSummary = null;
let overloadTimer = null;
function launcherWrite(message) {
  if (launcherLog === null || launcherBytes >= LAUNCHER_MAX_BYTES) return;
  try {
    const data = Buffer.from(message);
    const remaining = LAUNCHER_MAX_BYTES - launcherBytes;
    launcherBytes += fs.writeSync(launcherLog, data, 0, Math.min(data.length, remaining));
  } catch (_) { /* Storage failure must not mask the original error. */ }
}
function launchFatal(error) {
  let description;
  try { description = String(error && (error.stack || error.message) || error).slice(0, 8192); }
  catch (_) { description = 'uncaught launcher error (unavailable)'; }
  launcherWrite(new HostDate().toISOString() + ' ERROR [pmjs] launcher-uncaught ' +
    description + '\n');
}
function startLauncherLog() {
  if (launcherLog) return;
  const directory = process.env.PMJS_LOG_DIR || path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'pmjs');
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'launcher.log');
    // Small rolling previous-launch file; startup failures remain readable.
    try {
      if (fs.statSync(file).size >= 1024 * 1024) {
        try { fs.renameSync(file, file + '.previous'); } catch (_) {}
      }
    } catch (_) {}
    launcherLog = fs.openSync(file,
      fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { launcherBytes = fs.fstatSync(launcherLog).size; } catch (_) { launcherBytes = 0; }
    launcherWrite(new HostDate().toISOString() + ' INFO [pmjs] launcher-start pid=' + process.pid + '\n');
    // An error thrown before main().catch bypasses console.error entirely.
    // A monitor observes it without changing Node's standard exit behavior.
    process.once('uncaughtExceptionMonitor', launchFatal);
  } catch (error) {
    try { process.stderr.write('[pmjs] launcher log unavailable: ' + error.message + '\n'); } catch (_) {}
  }
}

function gamePluginSource() {
  let stack;
  try { stack = new Error().stack || ''; } catch (_) { return ''; }
  // Guest scripts are evaluated with their real filenames. Keep only the
  // plugin basename and line so launcher.log does not expose install paths.
  const match = stack.match(/[\\/]js[\\/]plugins[\\/]([^\\/\n]+\.js):(\d+):\d+\)?/);
  return match ? ` [${match[1]}:${match[2]}]` : '';
}

function emitConsoleMessage(target, method, level, source, message, count) {
  const repeat = count > 1 ? ` [x${count}]` : '';
  const prefix = `${new HostDate().toISOString()} ${level}${source}${repeat} `;
  const formatted = message.split('\n').map(line => prefix + line).join('\n');
  if (target === console) launcherWrite(formatted + '\n');
  target._pmjsRawConsole[method](formatted);
}

function flushPluginLogs() {
  if (pluginLogTimer) clearTimeout(pluginLogTimer);
  pluginLogTimer = null;
  for (const pending of pendingPluginLogs.values()) {
    emitConsoleMessage(pending.target, pending.method, pending.level,
      pending.source, pending.message, pending.count);
  }
  pendingPluginLogs.clear();
}

function flushOverloadSummary() {
  if (overloadTimer) clearTimeout(overloadTimer);
  overloadTimer = null;
  if (overloadSummary) {
    emitConsoleMessage(overloadSummary.target, overloadSummary.method, 'INFO', '',
      `[pmjs] performance-degradation overload_events=${overloadSummary.count} ` +
      `max_dropped_ms=${overloadSummary.maxDroppedMs.toFixed(1)} window_ms=60000`, 1);
    overloadSummary = null;
  }
}

function flushAllLogs() {
  flushPluginLogs();
  flushOverloadSummary();
}

function installConsoleLogging(target = console) {
  if (target._pmjsRawConsole) return;
  const levels = { log: 'INFO', info: 'INFO', debug: 'INFO', warn: 'WARN', error: 'ERROR' };
  const raw = {};
  for (const method of Object.keys(levels)) raw[method] = target[method].bind(target);
  Object.defineProperty(target, '_pmjsRawConsole', { value: raw });
  for (const [method, level] of Object.entries(levels)) {
    target[method] = (...args) => {
      const message = format(...args).replace(/\r\n?/g, '\n');
      const overload = level === 'INFO' && /\[pmjs\] overload-debt-clamp dropped_ms=([\d.]+)/.exec(message);
      if (overload) {
        const droppedMs = Number(overload[1]);
        if (Number.isFinite(droppedMs)) {
          if (overloadSummary && overloadSummary.target !== target) flushOverloadSummary();
          if (!overloadSummary) overloadSummary = { target, method, count: 0, maxDroppedMs: 0 };
          overloadSummary.count++;
          overloadSummary.maxDroppedMs = Math.max(overloadSummary.maxDroppedMs, droppedMs);
          if (!overloadTimer) overloadTimer = setTimeout(flushOverloadSummary, 60_000);
          if (typeof overloadTimer.unref === 'function') overloadTimer.unref();
          return;
        }
      }
      // Routine informational calls do not need stack inspection. Source
      // attribution is opt-in for investigations and remains enabled for
      // warnings/errors where it is most useful.
      const source = level === 'ERROR' || level === 'WARN' ||
        process.env.PMJS_LOG_PLUGIN_SOURCE === '1' ? gamePluginSource() : '';
      // Aggregate identical, single-line INFO calls using one bounded map and
      // one shared timer. This avoids stack walks and per-message timers.
      if (level === 'INFO' && !message.includes('\n') &&
          !message.startsWith('[pmjs] diagnostic ')) {
        const key = `${method}\0${source}\0${message}`;
        const pending = pendingPluginLogs.get(key);
        if (pending) {
          pending.count++;
          return;
        }
        if (pendingPluginLogs.size >= MAX_PENDING_PLUGIN_LOGS) {
          const oldestKey = pendingPluginLogs.keys().next().value;
          const oldest = pendingPluginLogs.get(oldestKey);
          pendingPluginLogs.delete(oldestKey);
          emitConsoleMessage(oldest.target, oldest.method, oldest.level,
            oldest.source, oldest.message, oldest.count);
        }
        pendingPluginLogs.set(key, { target, method, level, source, message, count: 1 });
        if (!pluginLogTimer) pluginLogTimer = setTimeout(flushPluginLogs, PLUGIN_REPEAT_WINDOW_MS);
        if (typeof pluginLogTimer.unref === 'function') pluginLogTimer.unref();
        return;
      }
      if (pendingPluginLogs.size) flushPluginLogs();
      emitConsoleMessage(target, method, level, source, message, 1);
    };
  }
}

process.once('exit', flushAllLogs);

module.exports = { installConsoleLogging, startLauncherLog };
