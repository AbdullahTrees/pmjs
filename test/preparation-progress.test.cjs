'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { progressLines, stageProgress } = require('../runner/index.cjs');

test('warm cache validation is distinguished from new preparation with counts, time and rate', () => {
  const progress = { phase: 'validate', source: 'img/pictures/portrait.png',
    total: 100, completed: 20, elapsedMs: 10000, hits: 20, generated: 0, fallback: 5 };
  const lines = progressLines(progress);
  assert.equal(lines[0], 'Checking cached assets');
  assert.match(lines[1], /20 \/ 100 done \(20%\).*80 left/);
  assert.equal(lines[2], 'Current file: img/pictures/portrait.png');
  assert.equal(lines[3], 'Cache: 0 new, 20 reused  |  Originals: 5');
  assert.equal(lines[4], 'Elapsed: 0:10  |  Average: 2.0 files/s');
  assert.equal(lines[5], 'Estimated time left: 0:40');
  assert.equal(progressLines({ ...progress, phase: 'prepare' })[0], 'Preparing new assets');
});

test('long first files keep elapsed time truthful without inventing speed or an ETA', () => {
  const lines = progressLines({ phase: 'prepare', source: 'img/sv_actors/large.png',
    total: 50, completed: 0, elapsedMs: 70000 });
  assert.match(lines[1], /50 left/);
  assert.match(lines[4], /Elapsed: 1:10.*estimating/);
  assert.match(lines[5], /Large files can take longer/);
  assert.ok(!lines.some(line => line.includes('Estimated time left')));
});

test('discovery, locking and finishing do not claim another transform is running', () => {
  assert.equal(progressLines({ phase: 'discover' })[1], 'Counting files...');
  assert.match(progressLines({ phase: 'wait' })[5], /Another launch/);
  for (const phase of ['install', 'cleanup']) {
    const lines = progressLines({ phase, completed: 10, total: 10, elapsedMs: 1000 });
    assert.equal(lines[0], 'Finishing asset preparation');
    assert.match(lines[1], /0 left/);
    assert.match(lines[5], /finishing up/);
  }
});

test('empty completion and terminal failure/cancellation retain truthful final state', () => {
  assert.match(progressLines({ phase: 'complete', terminal: true })[1], /0 \/ 0.*0 left/);
  for (const phase of ['cancelled', 'error']) {
    const lines = progressLines({ phase, terminal: true, completed: 4, total: 10, elapsedMs: 2000 });
    assert.match(lines[1], /6 left/);
    assert.ok(!lines.some(line => line.includes('Estimated time left')));
    assert.notEqual(lines[0], 'Assets ready');
  }
});

test('file labels preserve Unicode and flatten line breaks into a single screen row', () => {
  assert.equal(progressLines({ phase: 'prepare', source: 'img/pictures/caf\u00e9\nface.png' })[2],
    'Current file: img/pictures/caf\u00e9 face.png');
});

test('stage baseline keeps later stages from inheriting earlier wall time', () => {
  const withoutBaseline = progressLines({ phase: 'map-compile', source: 'data/Map001.json',
    total: 300, completed: 220, generated: 12, hits: 208, fallback: 1, elapsedMs: 300000 });
  assert.match(withoutBaseline[4], /Average: 0\.7 maps\/s/);
  const withBaseline = progressLines({ phase: 'map-compile', source: 'data/Map001.json',
    total: 300, completed: 220, generated: 12, hits: 208, fallback: 1, elapsedMs: 300000,
    stageCompleted: 200, stageElapsedMs: 10000 });
  assert.equal(withBaseline[0], 'Compiling maps');
  assert.match(withBaseline[1], /220 \/ 300 done \(73%\).*80 left/);
  assert.equal(withBaseline[3], 'Maps: 12 new, 208 reused  |  Skipped: 1');
  assert.equal(withBaseline[4], 'Elapsed: 5:00  |  Average: 2.0 maps/s');
  assert.equal(withBaseline[5], 'Estimated time left: 0:40');
});

test('map stages name themselves and estimate completion like working asset phases', () => {
  assert.equal(progressLines({ phase: 'map-validate' })[0], 'Checking cached maps');
  assert.equal(progressLines({ phase: 'map-pack' })[0], 'Packing maps');
  assert.equal(progressLines({ phase: 'map-wait' })[0], 'Waiting for map cache');
  assert.equal(progressLines({ phase: 'map-something-new' })[0], 'Preparing maps');
  assert.match(progressLines({ phase: 'map-wait' })[5], /Another launch/);
  assert.match(progressLines({ phase: 'map-validate', total: 10, completed: 1 })[5], /reused when unchanged/);
  const lines = progressLines({ phase: 'map-pack', total: 100, completed: 10,
    elapsedMs: 5000, stageCompleted: 0, stageElapsedMs: 5000 });
  assert.match(lines[4], /Average: 2\.0 maps\/s/);
  assert.equal(lines[5], 'Estimated time left: 0:45');
  const early = progressLines({ phase: 'map-compile', total: 100, completed: 2,
    elapsedMs: 1000, stageCompleted: 0, stageElapsedMs: 1000 });
  assert.ok(!early.some(line => line.includes('Estimated time left')));
});

test('asset-to-map handoff resets the rate baseline without touching totals', () => {
  let baseline = null;
  const frame = (current, elapsedMs) => {
    const stepped = stageProgress(current, elapsedMs, baseline);
    baseline = stepped.baseline;
    return progressLines(stepped.progress);
  };
  let lines = frame({ phase: 'discover', total: 0, completed: 0 }, 0);
  assert.match(lines[1], /Counting files/);
  lines = frame({ phase: 'validate', total: 1250, completed: 600,
    generated: 40, hits: 560, fallback: 0 }, 60000);
  assert.match(lines[4], /Average: 10\.0 files\/s/);
  assert.equal(lines[5], 'Estimated time left: 1:05');
  // Per-file validate/prepare flips stay inside one asset stage.
  lines = frame({ phase: 'prepare', total: 1250, completed: 601,
    generated: 41, hits: 560, fallback: 0 }, 61000);
  assert.match(lines[4], /Average: 9\.9 files\/s/);
  // Map stage restarts the clock: 5 maps in 10s, not 5 maps in 5 minutes.
  frame({ phase: 'map-compile', source: 'data/Map001.json', total: 200, completed: 0,
    generated: 0, hits: 0, fallback: 0 }, 300000);
  lines = frame({ phase: 'map-compile', source: 'data/Map006.json', total: 200, completed: 5,
    generated: 2, hits: 3, fallback: 0 }, 310000);
  assert.equal(lines[0], 'Compiling maps');
  assert.match(lines[1], /5 \/ 200 done \(2%\).*195 left/);
  assert.equal(lines[4], 'Elapsed: 5:10  |  Average: 0.5 maps/s');
  assert.equal(lines[5], 'Estimated time left: 6:30');
});
