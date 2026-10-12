'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const timers = require('node:timers');

function fixture(t, clock = performance) {
  const errors = [], fatals = [];
  const context = vm.createContext({ PMJS: {}, performance: clock, console,
    NativeHost: { runtime: { scheduling: { ...timers, onFatal: error => fatals.push(error) } } },
    pmjsReportEventError: error => errors.push(error) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/scheduler.js'), 'utf8'), context);
  t.after(() => context.PMJS.tasks.stop());
  return { context, errors, fatals };
}

for (const count of [2, 130]) test('FIFO callbacks checkpoint chained Promises, count=' + count, async t => {
  const { context } = fixture(t), trace = [];
  for (let i = 0; i < count; i++) context.PMJS.tasks.enqueue(() => {
    trace.push('task:' + i);
    Promise.resolve().then(() => Promise.resolve()).then(() => trace.push('micro:' + i));
  });
  await context.PMJS.tasks.idle();
  assert.deepEqual(trace, Array.from({ length: count }, (_, i) => ['task:' + i, 'micro:' + i]).flat());
});

test('work enqueued by a task follows existing tasks and its microtasks', async t => {
  const { context } = fixture(t), trace = [];
  context.PMJS.tasks.enqueue(() => {
    trace.push('A'); context.PMJS.tasks.enqueue(() => trace.push('C'));
    Promise.resolve().then(() => trace.push('micro'));
  });
  context.PMJS.tasks.enqueue(() => trace.push('B'));
  await context.PMJS.tasks.idle();
  assert.deepEqual(trace, ['A', 'micro', 'B', 'C']);
});

test('rAF snapshots retain cancellation, timestamps and next-frame registrations', async t => {
  const { context } = fixture(t), trace = [];
  let cancelled;
  context.requestAnimationFrame(now => {
    trace.push(['A', now]); context.cancelAnimationFrame(cancelled);
    Promise.resolve().then(() => {
      trace.push(['micro']); context.requestAnimationFrame(time => trace.push(['next', time]));
    });
  });
  cancelled = context.requestAnimationFrame(() => trace.push(['cancelled']));
  context.requestAnimationFrame(now => trace.push(['B', now]));
  await context.PMJS.tasks.runFrame(() => context.pmjsDrainScheduler(100));
  assert.deepEqual(trace, [['A', 100], ['micro'], ['B', 100]]);
  await context.PMJS.tasks.runFrame(() => context.pmjsDrainScheduler(116));
  assert.deepEqual(trace.at(-1), ['next', 116]);
});

test('rendering checkpoints hold resource callbacks and timer callbacks until submission', async t => {
  const { context } = fixture(t), trace = [];
  context.requestAnimationFrame(() => {
    trace.push('A'); context.PMJS.tasks.enqueue(() => trace.push('resource'));
    context.setTimeout(() => trace.push('timer'), 0);
    Promise.resolve().then(() => trace.push('micro'));
    Promise.resolve().then(() => context.PMJS.tasks.invoke(() => trace.push('io-completion')));
  });
  context.requestAnimationFrame(() => trace.push('B'));
  await context.PMJS.tasks.runFrame(() => context.pmjsDrainScheduler(1).then(() => trace.push('submit')));
  assert.deepEqual(trace.slice(0, 4), ['A', 'micro', 'B', 'submit']);
  await new Promise(resolve => timers.setTimeout(resolve, 10));
  await context.PMJS.tasks.idle();
  assert.ok(trace.includes('resource')); assert.ok(trace.includes('timer'));
  assert.ok(trace.indexOf('io-completion') > trace.indexOf('submit'));
});

test('pending frames bound a replenishing queue by callback count', async t => {
  const { context } = fixture(t, { now: () => 0 });
  let calls = 0;
  function replenish() { calls++; context.PMJS.tasks.enqueue(replenish); }
  context.PMJS.tasks.enqueue(replenish);
  await context.PMJS.tasks.runFrame(() => assert.equal(calls, 64));
  const before = calls;
  await context.PMJS.tasks.runFrame(() => assert.equal(calls - before, 64));
});

test('admission time includes callback microtasks and resets after expensive frames', async t => {
  let time = 0, calls = 0;
  const clock = { now: () => time };
  const { context } = fixture(t, clock);
  function replenish() {
    calls++;
    Promise.resolve().then(() => { time += 2; context.PMJS.tasks.enqueue(replenish); });
  }
  context.PMJS.tasks.enqueue(replenish);
  await context.PMJS.tasks.runFrame(() => { assert.equal(calls, 2); time += 50; });
  const before = calls;
  clock.now = () => 0;
  await context.PMJS.tasks.runFrame(() => assert.equal(calls - before, 2));
});

test('timers run without frames, checkpoint, accept arguments and cancel', async t => {
  const { context } = fixture(t), trace = [];
  const cancelled = context.setTimeout(() => trace.push('cancelled'), 0);
  context.clearTimeout(cancelled);
  context.setTimeout(value => {
    trace.push(value); Promise.resolve().then(() => trace.push('micro'));
  }, 0, 'A');
  await new Promise(resolve => context.setTimeout(() => { trace.push('B'); resolve(); }, 5));
  assert.deepEqual(trace, ['A', 'micro', 'B']);
});

test('intervals skip elapsed periods and stop after cancellation inside the callback', async t => {
  const { context } = fixture(t), trace = [];
  const completed = new Promise(resolve => {
    const id = context.setInterval(() => {
      trace.push(performance.now());
      if (trace.length === 2) { context.clearInterval(id); resolve(); }
    }, 2);
  });
  await completed;
  await new Promise(resolve => timers.setTimeout(resolve, 10));
  assert.equal(trace.length, 2);
});

test('browser callback errors report and preserve subsequent work', async t => {
  const { context, errors, fatals } = fixture(t), trace = [];
  context.PMJS.tasks.enqueue(() => { throw new Error('event failure'); }, { errorMode: 'event' });
  context.PMJS.tasks.enqueue(() => trace.push('next'));
  context.requestAnimationFrame(() => { throw new Error('raf failure'); });
  context.requestAnimationFrame(() => trace.push('raf'));
  await context.PMJS.tasks.idle();
  await context.PMJS.tasks.runFrame(() => context.pmjsDrainScheduler(10));
  assert.deepEqual(errors.map(e => e.message), ['event failure', 'raf failure']);
  assert.deepEqual(fatals, []); assert.deepEqual(trace, ['next', 'raf']);
});

test('fatal callbacks stop delivery and discard retained results', async t => {
  const { context, fatals } = fixture(t), trace = [];
  context.PMJS.tasks.enqueue(() => { throw new Error('node callback'); });
  context.PMJS.tasks.enqueue(() => trace.push('unexpected'), { discard: () => trace.push('released') });
  await context.PMJS.tasks.idle();
  assert.deepEqual(fatals.map(e => e.message), ['node callback']);
  assert.deepEqual(trace, ['released']);
  assert.equal(context.PMJS.tasks.enqueue(() => trace.push('late'), { discard: () => trace.push('late release') }), false);
  assert.deepEqual(trace, ['released', 'late release']);
});
