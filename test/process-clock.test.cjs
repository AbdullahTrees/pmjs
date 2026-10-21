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
  const logs = [];
  const guestConsole = Object.assign({}, console, { error(...args) { logs.push(args); } });
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
});
