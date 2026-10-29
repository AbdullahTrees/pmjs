'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createFrameStats, PHASES } = require('../runner/frame-stats.cjs');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');

function makeStats(options = {}) {
  const lines = [];
  let time = 0;
  const stats = createFrameStats({
    file: '/dev/null',
    intervalMs: 1000,
    capacity: 64,
    now: () => time,
    write: line => lines.push(JSON.parse(line)),
    logger: { warn: () => {} },
    observeGc: false,
    memoryUsage: () => ({ rss: 1000, heapUsed: 500, external: 20 }),
    ...options
  });
  return { stats, lines, advance: ms => { time += ms; } };
}

function simpleFrame(stats, advance) {
  stats.frameStart();
  advance(1); stats.markTick();
  advance(1); stats.markRender();
  advance(1); stats.markRenderFrame();
  advance(1); stats.markSwap();
  stats.frameEnd();
  advance(1);
}

test('disabled without a stats file', () => {
  assert.strictEqual(createFrameStats({}), null);
});

test('phase durations and counters are recorded', () => {
  const { stats, lines, advance } = makeStats();
  stats.frameStart();
  advance(2); stats.markTick();                             // tick 2
  stats.guest.enter(0); advance(1); stats.guest.leave(0);   // prepare 1
  stats.guest.enter(1); advance(2); stats.guest.leave(1);   // encode 2
  stats.guest.enter(2); advance(1); stats.guest.leave(2);   // submit 1
  advance(5); stats.markRender();                           // render 4 + 5 = 9
  advance(4); stats.markRenderFrame();                      // renderFrame 4
  advance(1); stats.markSwap();                             // swap 1
  stats.guest.addNodes(42);
  stats.guest.addRecords(40);
  stats.frameEnd();
  advance(1);
  const summary = stats.stop();
  assert.ok(summary);
  assert.strictEqual(summary.frames, 1);
  assert.strictEqual(summary.phases.tick.p50, 2);
  assert.strictEqual(summary.phases.render.p50, 9);
  assert.strictEqual(summary.phases.prepare.p50, 1);
  assert.strictEqual(summary.phases.encode.p50, 2);
  assert.strictEqual(summary.phases.submit.p50, 1);
  assert.strictEqual(summary.phases.renderFrame.p50, 4);
  assert.strictEqual(summary.phases.swap.p50, 1);
  assert.strictEqual(summary.nodes.p50, 42);
  assert.strictEqual(summary.records.p50, 40);
  assert.deepStrictEqual(lines[0].phases.prepare, { p50: 1, p95: 1, max: 1 });
});

test('guest spans accumulate within one frame; orphan leaves are ignored', () => {
  const { stats, advance } = makeStats();
  stats.frameStart();
  stats.markTick();
  stats.guest.leave(0); // no enter: ignored
  stats.guest.enter(0); advance(1); stats.guest.leave(0);
  stats.guest.enter(0); advance(2); stats.guest.leave(0);
  stats.guest.enter(0); stats.guest.enter(0); advance(3); stats.guest.leave(0); // re-enter wins
  stats.markRender();
  stats.markRenderFrame();
  stats.markSwap();
  stats.frameEnd();
  const summary = stats.stop();
  assert.strictEqual(summary.phases.prepare.p50, 6);
});

test('missing marks discard the frame', () => {
  const { stats } = makeStats();
  stats.frameStart();
  stats.markTick();
  stats.frameEnd(); // no render/renderFrame/swap marks
  const summary = stats.stop();
  assert.strictEqual(summary, null);
});

test('sampling honours the interval and resets the window', () => {
  const { stats, lines, advance } = makeStats({ intervalMs: 25, capacity: 100 });
  for (let index = 0; index < 12; index++) simpleFrame(stats, advance);
  stats.stop();
  assert.deepStrictEqual(lines.map(line => line.frames), [6, 5, 1]);
  const total = lines.reduce((sum, line) => sum + line.frames, 0);
  assert.strictEqual(total, 12);
});

test('a full window is emitted before it can overflow', () => {
  const { stats, lines, advance } = makeStats({ intervalMs: 1000000, capacity: 4 });
  for (let index = 0; index < 10; index++) simpleFrame(stats, advance);
  stats.stop();
  assert.deepStrictEqual(lines.map(line => line.frames), [4, 4, 2]);
});

test('percentiles use nearest rank over the window', () => {
  const { stats, advance } = makeStats({ intervalMs: 1000000, capacity: 100 });
  for (let index = 0; index < 100; index++) {
    stats.frameStart();
    advance(index + 1); stats.markTick(); // tick = 1..100
    stats.markRender();
    stats.markRenderFrame();
    stats.markSwap();
    stats.frameEnd();
    advance(1);
  }
  const summary = stats.stop();
  assert.strictEqual(summary.phases.tick.p50, 50);
  assert.strictEqual(summary.phases.tick.p95, 95);
  assert.strictEqual(summary.phases.tick.max, 100);
});

test('summary is published as PMJS.stats.frame', () => {
  const previous = globalThis.PMJS;
  try {
    globalThis.PMJS = { stats: {} };
    const { stats, advance } = makeStats();
    simpleFrame(stats, advance);
    stats.stop();
    assert.ok(globalThis.PMJS.stats.frame, 'published');
    assert.strictEqual(globalThis.PMJS.stats.frame.frames, 1);
    for (const phase of PHASES) assert.ok(globalThis.PMJS.stats.frame.phases[phase]);
  } finally {
    if (previous === undefined) delete globalThis.PMJS;
    else globalThis.PMJS = previous;
  }
});

test('stop flushes the open window and removes the guest hook', () => {
  const { stats, advance } = makeStats();
  const previous = globalThis.pmjsFrameStats;
  try {
    globalThis.pmjsFrameStats = stats.guest;
    simpleFrame(stats, advance);
    const summary = stats.stop();
    assert.strictEqual(summary.frames, 1);
    assert.strictEqual(globalThis.pmjsFrameStats, undefined);
  } finally {
    if (previous !== undefined) globalThis.pmjsFrameStats = previous;
  }
});

test('scene encoder harness reports prepare nodes, encode span and records', () => {
  const harness = makeHarness();
  const sandbox = harness.sandbox;
  const calls = { nodes: 0, encodes: 0, submits: 0, records: 0 };
  const depths = { encode: 0, submit: 0 };
  sandbox.pmjsFrameStats = {
    enter(slot) { if (slot === 1) depths.encode++; if (slot === 2) depths.submit++; },
    leave(slot) {
      if (slot === 1) { depths.encode--; calls.encodes++; }
      if (slot === 2) { depths.submit--; calls.submits++; }
    },
    addNodes(count) { calls.nodes += count; },
    addRecords(count) { calls.records += count; }
  };
  const stage = new sandbox.PIXI.Container();
  stage._boundsID = 0;
  stage.parent = { transform: {} }; // renderNativeStage replaces the stage parent while preparing
  stage.transform.updateTransform = function() {};
  const sprite = harness.sprite(32, 32);
  sprite._bounds = { updateID: 0 };
  sprite.transform.updateTransform = function() {};
  stage.addChild(sprite);
  const plan = new Map();
  plan.set(stage, { method: stage.updateTransform, nativePreparation: true,
    equivalent: { kind: 'container' } });
  plan.set(sprite, { method: sprite.updateTransform, nativePreparation: true,
    equivalent: { kind: 'leaf' } });
  sandbox.PMJS.pixi4.scenePreparation.transforms(plan, stage);
  assert.strictEqual(calls.nodes, 2, 'stage + sprite visited');
  sandbox.submitNativeScene(stage);
  assert.strictEqual(calls.encodes, 1, 'one encode span');
  assert.strictEqual(calls.submits, 1, 'one submit span');
  assert.strictEqual(depths.encode, 0);
  assert.strictEqual(depths.submit, 0);
  assert.strictEqual(calls.records, harness.submitted.at(-1).count);
  assert.ok(calls.records > 0);
});
