'use strict';

const childProcess = require('node:child_process');
const hostProcess = require('node:process');
const hostTimers = require('node:timers');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function createSubprocesses({ tasks, resolveDirectory, openExternal }) {
  const children = new Set();
  let stopping = false;
  function enqueue(callback, errorMode = 'event') { tasks().enqueue(callback, { errorMode }); }
  function optionsFor(options) {
    if (stopping) throw Object.assign(new Error('session has terminated'), { code: 'ERR_RUNTIME_STOPPED' });
    return { ...options, detached: true, cwd: resolveDirectory(options && options.cwd || '/game') };
  }
  function wrap(child, callbackHandlesErrors = false) {
    children.add(child);
    const emitter = new EventEmitter();
    const result = typeof tasks().wrapNodeEmitter === 'function'
      ? tasks().wrapNodeEmitter(emitter, ['emit']) : emitter;
    result.pid = child.pid;
    result.stdin = child.stdin;
    result.kill = child.kill.bind(child);
    result.ref = () => { child.ref(); return result; };
    result.unref = () => { child.unref(); return result; };
    for (const name of ['stdout', 'stderr']) {
      if (!child[name]) { result[name] = null; continue; }
      const outputTarget = new PassThrough();
      result[name] = typeof tasks().wrapNodeEmitter === 'function'
        ? tasks().wrapNodeEmitter(outputTarget, ['emit', 'write', 'read']) : outputTarget;
      child[name].on('data', data => enqueue(() => outputTarget.write(data)));
      child[name].on('end', () => enqueue(() => outputTarget.end()));
      child[name].on('error', error => enqueue(() => outputTarget.destroy(error)));
    }
    for (const name of ['spawn', 'error', 'exit', 'close']) child.on(name, (...args) => {
      if (name === 'close') children.delete(child);
      enqueue(() => {
        if (name === 'exit') { result.exitCode = args[0]; result.signalCode = args[1]; }
        if (name !== 'error' || !callbackHandlesErrors || result.listenerCount('error')) result.emit(name, ...args);
      }, 'uncaught');
    });
    return result;
  }
  function exec(command, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const resolvedOptions = optionsFor(options);
    // These desktop URL commands have no shell composition or file operands.
    const match = /^(?:open|xdg-open|rundll32(?:\.exe)? url\.dll,FileProtocolHandler)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|(\S+))\s*$/.exec(command);
    const url = match && (match[1] || match[2] || match[3]);
    if (url && /^(https?:\/\/|mailto:)/i.test(url) && !/[\x00-\x20]/.test(url)) {
      const result = new EventEmitter();
      result.kill = () => false;
      enqueue(() => {
        let error = null;
        try { if (!openExternal(url)) throw Object.assign(new Error('system browser could not open URL'), { code: 1, cmd: command }); }
        catch (caught) { error = caught; }
        result.exitCode = error ? 1 : 0;
        result.signalCode = null;
        enqueue(() => result.emit('exit', result.exitCode, null), 'uncaught');
        if (callback) enqueue(() => callback(error, '', ''), 'uncaught');
        enqueue(() => result.emit('close', result.exitCode, null), 'uncaught');
      });
      return result;
    }
    return wrap(childProcess.exec(command, resolvedOptions, typeof callback === 'function'
      ? (error, stdout, stderr) => enqueue(() => callback(error, stdout, stderr), 'uncaught') : undefined), typeof callback === 'function');
  }
  return {
    api: {
      exec,
      execFile(file, args, options, callback) {
        if (!Array.isArray(args)) { callback = options; options = args; args = []; }
        if (typeof options === 'function') { callback = options; options = {}; }
        return wrap(childProcess.execFile(file, args, optionsFor(options), typeof callback === 'function'
          ? (error, stdout, stderr) => enqueue(() => callback(error, stdout, stderr), 'uncaught') : undefined), typeof callback === 'function');
      },
      spawn(file, args, options) {
        if (!Array.isArray(args)) { options = args; args = []; }
        return wrap(childProcess.spawn(file, args, optionsFor(options)));
      }
    },
    async stop() {
      stopping = true;
      await Promise.all(Array.from(children, child => new Promise(resolve => {
        function signal(name) {
          if (!Number.isInteger(child.pid)) return;
          try { hostProcess.kill(-child.pid, name); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        const force = hostTimers.setTimeout(() => signal('SIGKILL'), 500);
        child.once('close', () => { hostTimers.clearTimeout(force); resolve(); });
        signal('SIGTERM');
      })));
    }
  };
}

module.exports = { createSubprocesses };
