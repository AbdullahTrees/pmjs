'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createMemoryGuard, garbageCollector } = require('../runner/memory-guard.cjs');

const MiB = 1024 * 1024;

function harness({ env = {}, memories, decodes = 0 } = {}) {
  let clock = 0, index = 0;
  const calls = { guest: 0, gc: 0, trim: 0 };
  const guest = { __pmjsMemoryCull() { calls.guest++; return { cachedImages: 10, keptImages: 3 }; },
    SceneManager: { _scene: new (class Scene_Map {})() }, $gameMap: { mapId: () => 87 }, $gameParty: { size: () => 4 } };
  const native = { runtime: { trimAllocator() { calls.trim++; return true; } },
    images: { memory: () => ({ cpuBytes: 100 * MiB, gpuBytes: 50 * MiB, liveCount: 9, pendingDecodeJobs: decodes }) } };
  const guard = createMemoryGuard({ native, guest, env: { PMJS_MEMORY_GUARD: '1', ...env },
    readMemory: () => memories[Math.min(index, memories.length - 1)],
    readHeap: () => ({ used: 150 * MiB, total: 180 * MiB }),
    now: () => clock, collectGarbage: () => calls.gc++, logger: { log() {}, warn() {} } });
  return { guard, calls, step(ms = 1000) { clock += ms; const record = guard.sample(); index++; return record; } };
}

const at = (rssMB, availMB) => ({ rssBytes: rssMB * MiB, availableBytes: availMB * MiB });

test('samples carry memory, images and game context without culling below the threshold', () => {
  const { step, calls } = harness({ memories: [at(450, 300)] });
  const record = step();
  assert.deepEqual([record.rssMB, record.availMB, record.heapMB, record.imgCpuMB, record.map, record.scene, record.party],
    [450, 300, 150, 100, 87, 'Scene_Map', 4]);
  assert.equal(record.cull, undefined);
  assert.deepEqual(calls, { guest: 0, gc: 0, trim: 0 });
});

test('above the threshold a cull runs once, then again only after growth and the minimum interval', () => {
  // The fake re-reads the same sample after a cull, so each cull's baseline is that sample.
  const { step, calls } = harness({ memories: [at(520, 200), at(530, 190), at(540, 180), at(560, 170)] });
  assert.equal(step().cull.reason, 'rss-growth'); // 520 > 500: first cull, baseline 520
  assert.equal(step().cull, undefined);           // 530 one second later: inside the 5 s interval
  assert.equal(step(5000).cull, undefined);       // 540: only 20 MB above the baseline
  assert.equal(step(5000).cull.reason, 'rss-growth'); // 560 >= 520 + 32
  assert.deepEqual(calls, { guest: 2, gc: 2, trim: 2 });
});

test('critically low available memory culls without growth, but never during image decodes', () => {
  const busy = harness({ memories: [at(510, 80)], decodes: 2 });
  assert.equal(busy.step().cull, undefined);
  const idle = harness({ memories: [at(510, 80), at(505, 80)] });
  assert.equal(idle.step().cull.reason, 'critical-available');
  assert.equal(idle.step(6000).cull.reason, 'critical-available');
});

test('the safety net culls on low available memory even below the RSS threshold', () => {
  const net = harness({ env: { PMJS_MEMORY_CULL_MB: '0', PMJS_MEMORY_CRITICAL_MB: '150' }, memories: [at(300, 200), at(320, 140)] });
  assert.equal(net.step().cull, undefined);
  assert.equal(net.step(6000).cull.reason, 'critical-available');
});

test('both triggers at 0 log without culling; disabled guards do nothing', () => {
  const logging = harness({ env: { PMJS_MEMORY_CULL_MB: '0', PMJS_MEMORY_CRITICAL_MB: '0' }, memories: [at(700, 40)] });
  assert.equal(logging.step().cull, undefined);
  const off = createMemoryGuard({ native: {}, env: {}, readMemory: () => at(700, 40), now: () => 0 });
  assert.equal(off.enabled, false);
  assert.equal(off.sample(), null);
});

test('the log gets one JSON line per sample and is synced on the configured interval', () => {
  const directory = temporaryDirectory('memory-guard-');
  const file = path.join(directory, 'memory.log');
  let syncs = 0;
  const fileSystem = { ...fs, fdatasyncSync(fd) { syncs++; return fs.fdatasyncSync(fd); } };
  let clock = 0;
  const guard = createMemoryGuard({ native: {}, env: { PMJS_MEMORY_LOG: file, PMJS_MEMORY_LOG_SYNC_MS: '3000' },
    readMemory: () => at(300, 400), now: () => clock, fileSystem, logger: { log() {}, warn() {} } });
  for (let second = 0; second < 7; second++) { clock += 1000; guard.sample(); }
  guard.stop({ clearInterval() {} });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 7);
  assert.equal(lines[6].rssMB, 300);
  assert.equal(syncs, 3 + 1); // seconds 1, 4, 7, plus the final sync on stop
});

test('the garbage collector helper returns a working full collection', () => {
  const collect = garbageCollector();
  assert.equal(typeof collect, 'function');
  collect();
});
