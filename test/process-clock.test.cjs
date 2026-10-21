'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('guest process retains monotonic tuple, difference and bigint clocks', () => {
  const hostCwd = process.cwd();
  const context = vm.createContext({ process, PMJS: { config: {}, tasks: { onStop() {} } }, __pmjsBuiltinRequire: require, location: {},
    nativePlatform: { platform: process.platform, arch: process.arch }, NativeHost: { fs: { readText() { return null; } }, runtime: { isFullscreen: () => false } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/modules.js'), 'utf8'), context);
  const before = process.hrtime.bigint();
  const start = context.process.hrtime();
  const diff = context.process.hrtime(start);
  const bigint = context.process.hrtime.bigint();
  const after = process.hrtime.bigint();
  assert.equal(start.length, 2);
  assert.equal(diff.length, 2);
  for (const [seconds, nanoseconds] of [start, diff]) {
    assert.ok(Number.isInteger(seconds) && seconds >= 0);
    assert.ok(Number.isInteger(nanoseconds) && nanoseconds >= 0 && nanoseconds < 1e9);
  }
  assert.ok(bigint >= before && bigint <= after);
  assert.throws(() => context.process.hrtime('invalid'), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(context.process.cwd(), '/game');
  assert.equal(process.cwd(), hostCwd);
});

test('guest uncaught Node exceptions reach process listeners and preserve later work', async t => {
  const logs = [], warnings = [];
  const guestConsole = Object.assign({}, console, { error(...args) { logs.push(args); }, warn(...args) { warnings.push(args); } });
  const context = vm.createContext({ process, performance, console: guestConsole,
    PMJS: { config: {} }, __pmjsBuiltinRequire: require,
    location: {},
    NativeHost: { fs: { readText() { return null; } },
      runtime: { isFullscreen: () => false, scheduling: require('node:timers') } },
    nativePlatform: { platform: process.platform, arch: process.arch } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/scheduler.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/modules.js'), 'utf8'), context);
  t.after(() => context.PMJS.tasks.stop());

  const error = new Error('guest callback failure'), delivered = [], trace = [];
  const syncError = new Error('synchronous listener failure');
  context.process.once('sync-event', () => { throw syncError; });
  assert.throws(() => context.process.emit('sync-event'), received => received === syncError);
  context.process.once('uncaughtException', received => delivered.push(received));
  context.PMJS.tasks.enqueue(() => { throw error; }, { errorMode: 'uncaught' });
  context.PMJS.tasks.enqueue(() => trace.push('continued'));
  await context.PMJS.tasks.idle();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0], error);
  assert.deepEqual(trace, ['continued']);
  assert.equal(context.process.listenerCount('uncaughtException'), 0);

  const fallbackError = new Error('unhandled guest callback failure');
  context.PMJS.tasks.enqueue(() => { throw fallbackError; }, { errorMode: 'uncaught' });
  context.PMJS.tasks.enqueue(() => trace.push('continued after log'));
  await context.PMJS.tasks.idle();
  assert.deepEqual(logs, [[ '[pmjs] uncaught exception in Node callback:', fallbackError ]]);
  assert.deepEqual(trace, ['continued', 'continued after log']);

  const nextTickError = new Error('nextTick callback failure'), nextTickArguments = [];
  context.process.once('uncaughtException', received => nextTickArguments.push(received));
  context.process.nextTick(function(value) {
    assert.equal(value, 'nextTick argument');
    throw nextTickError;
  }, 'nextTick argument');
  context.PMJS.tasks.enqueue(() => trace.push('continued after nextTick'));
  await context.PMJS.tasks.idle();
  assert.deepEqual(nextTickArguments, [nextTickError]);
  assert.deepEqual(trace, ['continued', 'continued after log', 'continued after nextTick']);

  const returnedPromise = Promise.resolve('node callback result');
  context.PMJS.tasks.enqueue(() => returnedPromise, { errorMode: 'uncaught' });
  await context.PMJS.tasks.idle();
  assert.equal(context.PMJS.tasks.guestPromiseOrigin(returnedPromise), 'node');

  const emitter = new (require('node:events').EventEmitter)();
  const guestEmitter = context.PMJS.tasks.wrapNodeEmitter(emitter, ['emit']);
  const listenerPromise = Promise.resolve('event listener result');
  guestEmitter.on('event', () => listenerPromise);
  guestEmitter.emit('event');
  assert.equal(context.PMJS.tasks.guestPromiseOrigin(listenerPromise), 'node');

  const reason = new Error('rejection reason'), rejectedPromise = Promise.resolve();
  let nodeUnhandled, nodeHandled, browserUnhandled, browserHandled;
  context.process.once('unhandledRejection', (received, promise) => { nodeUnhandled = [received, promise]; });
  context.process.once('rejectionHandled', promise => { nodeHandled = promise; });
  context.dispatchEvent = event => {
    if (event.type === 'unhandledrejection') { browserUnhandled = event; event.preventDefault(); }
    if (event.type === 'rejectionhandled') browserHandled = event;
  };
  context.pmjsReportUnhandledPromiseRejection(reason, rejectedPromise, 'node');
  context.pmjsReportHandledPromiseRejection(rejectedPromise, 'node');
  context.pmjsReportUnhandledPromiseRejection(reason, rejectedPromise, 'browser');
  context.pmjsReportHandledPromiseRejection(rejectedPromise, 'browser');
  assert.deepEqual(nodeUnhandled, [reason, rejectedPromise]);
  assert.equal(nodeHandled, rejectedPromise);
  assert.equal(browserUnhandled.reason, reason);
  assert.equal(browserUnhandled.promise, rejectedPromise);
  assert.equal(browserHandled.type, 'rejectionhandled');

  const unobservedPromise = Promise.resolve();
  context.pmjsReportUnhandledPromiseRejection(reason, unobservedPromise, 'node');
  context.pmjsReportHandledPromiseRejection(unobservedPromise, 'node');
  const warningText = warnings.map(args => String(args[0])).join('\n');
  assert.match(warningText, /UnhandledPromiseRejectionWarning/);
  assert.match(warningText, /DEP0018/);
  assert.match(warningText, /PromiseRejectionHandledWarning/);
});

test('read stream listener exceptions unwind the event without making internal tasks nonfatal', async t => {
  const context = vm.createContext({ process, performance, console, Buffer,
    PMJS: { config: {} }, __pmjsBuiltinRequire: require, location: {},
    NativeHost: { fs: {
      readText() { return null; },
      async openReadAsync() {
        let read = false;
        return { async readAsync() {
          if (read) return Buffer.alloc(0);
          read = true;
          return Buffer.from('data');
        }, close() {} };
      }
    }, runtime: { isFullscreen: () => false, scheduling: require('node:timers') } },
    nativePlatform: { platform: process.platform, arch: process.arch } });
  for (const file of ['scheduler.js', 'modules.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web', file), 'utf8'), context);
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/filesystem.js'), 'utf8'), context);
  t.after(() => context.PMJS.tasks.stop());

  const trace = [];
  const openError = new Error('stream open listener');
  const openCaught = new Promise(resolve => context.process.once('uncaughtException', resolve));
  const openStream = context.fsModule.createReadStream('open-error');
  openStream.on('open', () => { throw openError; });
  openStream.on('open', () => trace.push('later open listener'));
  assert.equal(await openCaught, openError);
  await context.PMJS.tasks.idle();
  assert.deepEqual(trace, []);
  const openClosed = new Promise(resolve => openStream.once('close', resolve));
  openStream.destroy();
  await openClosed;

  const dataError = new Error('stream data listener');
  const dataCaught = new Promise(resolve => context.process.once('uncaughtException', resolve));
  const dataStream = context.fsModule.createReadStream('data-error');
  dataStream.on('data', () => { throw dataError; });
  dataStream.on('data', () => trace.push('later data listener'));
  assert.equal(await dataCaught, dataError);
  await context.PMJS.tasks.idle();
  assert.deepEqual(trace, []);
  const dataClosed = new Promise(resolve => dataStream.once('close', resolve));
  dataStream.destroy();
  await dataClosed;

  context.PMJS.tasks.enqueue(() => trace.push('later scheduler task'));
  await context.PMJS.tasks.idle();
  assert.deepEqual(trace, ['later scheduler task']);
});
