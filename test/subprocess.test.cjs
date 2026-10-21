'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createSubprocesses } = require('../runner/subprocess.cjs');

function subprocesses() {
  const queue = [], root = temporaryDirectory('subprocess-'), opened = [], nodeErrors = [];
  let stopped = false;
  const service = createSubprocesses({
    tasks: () => ({ enqueue(callback, options) { if (!stopped) queue.push({ callback, options }); } }),
    resolveDirectory(virtual) { assert.equal(virtual, '/game'); return root; },
    openExternal(url) { opened.push(url); return true; }
  });
  return { ...service, root, opened,
    nodeErrors,
    drain() {
      while (queue.length) {
        const task = queue.shift();
        try { task.callback(); }
        catch (error) {
          if (task.options?.errorMode === 'uncaught') nodeErrors.push(error);
          else throw error;
        }
      }
    },
    terminate() { stopped = true; queue.length = 0; service.stop(); } };
}

test('subprocess callbacks preserve output, errors, cwd and argument boundaries through dispatcher', async () => {
  const root = temporaryDirectory('subprocess-');
  const h = createSubprocesses({ tasks: () => ({ enqueue: callback => setImmediate(callback) }),
    resolveDirectory(virtual) { assert.equal(virtual, '/game'); return root; }, openExternal() {} });
  let child, synchronous = true;
  const completion = new Promise(resolve => {
    child = h.api.execFile(process.execPath,
      ['-e', 'process.stdout.write(process.cwd());process.stderr.write("warning");process.exitCode=7;'],
      { cwd: '/game' }, (error, stdout, stderr) => {
        assert.equal(synchronous, false);
        resolve({ error, stdout, stderr });
      });
    child.on('error', error => assert.fail(error));
  });
  synchronous = false;
  const result = await completion;
  assert.equal(result.error.code, 7);
  assert.equal(result.stdout, root);
  assert.equal(result.stderr, 'warning');
  h.stop();
});

test('verified platform URL commands use the host browser and terminated callbacks are discarded', () => {
  const h = subprocesses();
  const results = [];
  for (const command of ['open "https://example.com/a"', 'rundll32 url.dll,FileProtocolHandler https://example.com/b']) {
    h.api.exec(command, (error, stdout, stderr) => results.push([error, stdout, stderr]));
  }
  assert.equal(results.length, 0);
  h.drain();
  assert.deepEqual(results, [[null, '', ''], [null, '', '']]);
  assert.deepEqual(h.opened, ['https://example.com/a', 'https://example.com/b']);
  h.api.exec('open https://example.com/terminated', () => assert.fail('callback after shutdown'));
  h.terminate(); h.drain();
  assert.equal(h.opened.length, 2);
});

test('child process callbacks and emitted events use Node exception delivery', () => {
  const h = subprocesses(), callbackError = new Error('exec callback'), exitError = new Error('exit listener');
  const trace = [];
  const child = h.api.exec('open https://example.com/callback', () => { throw callbackError; });
  child.on('exit', () => { throw exitError; });
  child.on('close', () => trace.push('close'));
  h.drain();
  assert.deepEqual(h.nodeErrors, [exitError, callbackError]);
  assert.deepEqual(trace, ['close']);
});

test('spawn and exit listener exceptions do not prevent later child events', async () => {
  const root = temporaryDirectory('subprocess-events-'), nodeErrors = [], trace = [];
  const spawnError = new Error('spawn listener'), exitError = new Error('exit listener');
  const service = createSubprocesses({
    tasks: () => ({ enqueue(callback, options = {}) {
      setImmediate(() => {
        try { callback(); }
        catch (error) {
          if (options.errorMode === 'uncaught') nodeErrors.push(error);
          else throw error;
        }
      });
    } }),
    resolveDirectory: () => root,
    openExternal: () => true
  });
  const child = service.api.spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5)']);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('spawn', () => { trace.push('spawn'); throw spawnError; });
    child.on('exit', () => { trace.push('exit'); throw exitError; });
    child.on('close', () => { trace.push('close'); resolve(); });
  });
  assert.deepEqual(nodeErrors, [spawnError, exitError]);
  assert.deepEqual(trace, ['spawn', 'exit', 'close']);
  await service.stop();
});

test('child output listener exceptions use the guest Node dispatcher', async t => {
  const nodeErrors = [], context = vm.createContext({
    console, performance, __pmjsBuiltinRequire: require,
    NativeHost: { runtime: { scheduling: require('node:timers') } },
    PMJS: {}, pmjsReportNodeException(error) { nodeErrors.push(error); }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../js/pmjs-web/scheduler.js'), 'utf8'), context);
  const tasks = context.PMJS.tasks;
  const service = createSubprocesses({ tasks: () => tasks,
    resolveDirectory: () => temporaryDirectory('subprocess-output-'), openExternal: () => true });
  t.after(async () => { await service.stop(); tasks.stop(); });

  const listenerError = new Error('stdout listener');
  const child = service.api.spawn(process.execPath,
    ['-e', 'process.stdout.write("output"); setTimeout(() => process.exit(0), 5)']);
  child.stdout.on('data', () => { throw listenerError; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await tasks.idle();
  assert.deepEqual(nodeErrors, [listenerError]);
});

test('session shutdown settles owned subprocesses and rejects later launches', async () => {
  const root = temporaryDirectory('subprocess-stop-');
  const service = createSubprocesses({ tasks: () => ({ enqueue: callback => setImmediate(callback) }),
    resolveDirectory: () => root, openExternal: () => true });
  const child = service.api.spawn(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},60000);']);
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  await service.stop();
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.throws(() => service.api.spawn(process.execPath, []), { code: 'ERR_RUNTIME_STOPPED' });
  assert.throws(() => service.api.exec('open https://example.com/after-stop'), { code: 'ERR_RUNTIME_STOPPED' });
});
