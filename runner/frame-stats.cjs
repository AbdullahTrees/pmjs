'use strict';

// Per-phase frame timing for the runtime, off unless PMJS_FRAME_STATS names a file.
//
// Phases per frame (milliseconds):
//   tick         __pmjsTick (game logic)
//   render       __pmjsRender wall time; contains prepare/encode/submit
//   prepare      transform plan build + transform preparation (renderNativeStage)
//   encode       scene record encoding (encodeNativeScene)
//   submit       NativeHost.scene.submit
//   renderFrame  native.renderFrame (GL draw)
//   swap         native.swapFrame
// plus per-frame counters: nodes visited by prepareTransforms, records written per frame.
//
// prepare/encode/submit are measured by guest hooks inside scene-packet.js/scene-prepare.js
// through globalThis.pmjsFrameStats; everything else is measured here around the frame-loop
// calls. The gauges accumulate across multiple render passes in a frame (render targets).
//
// Every intervalMs a JSON line is appended to the stats file:
//   {type:"frame-stats",time,frames,elapsedMs,fps,phases:{tick:{p50,p95,max},...},
//    nodes:{...},records:{...},gc:{count,pauseMs},memory:{rssBytes,heapUsedBytes,externalBytes}}
// and the latest summary is published as PMJS.stats.frame.
//
// When no file is configured, createFrameStats returns null and the runtime keeps a null check
// per frame-loop phase plus one branch around a global read per prepare/encode call; the guest
// hooks never exist. No buffers, no timers, no allocations.
//
// Storage model: each window fills the buffers from index 0; a window is emitted every
// intervalMs or before it would exceed capacity, so percentiles never span two windows.

const fs = require('node:fs');
const { performance, PerformanceObserver } = require('node:perf_hooks');

// The bootstrap replaces the guest's global `process` with a fake; host services captured at
// module load keep pointing at the real one (same rule as diagnostics.cjs).
const hostProcess = process;
const hostMemoryUsage = () => hostProcess.memoryUsage();
const hostConsole = console;

const PHASES = ['tick', 'render', 'prepare', 'encode', 'submit', 'renderFrame', 'swap'];
const PREPARE_SLOT = 0, ENCODE_SLOT = 1, SUBMIT_SLOT = 2, GUEST_SLOTS = 3;

function percentiles(values, count) {
  if (!count) return null;
  const sorted = Array.from(values.subarray(0, count)).sort((a, b) => a - b);
  const at = fraction => sorted[Math.min(count - 1, Math.max(0, Math.ceil(fraction * count) - 1))];
  const round = value => Math.round(value * 1000) / 1000;
  return { p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[count - 1]) };
}

function createFrameStats({ file, intervalMs = 5000, capacity = 1800,
    now = () => performance.now(), write = line => fs.appendFileSync(file, line + '\n'),
    logger = hostConsole, observeGc = true, memoryUsage = hostMemoryUsage } = {}) {
  if (!file) return null;
  const rows = PHASES.map(() => new Float64Array(capacity));
  const nodeRows = new Float64Array(capacity);
  const recordRows = new Float64Array(capacity);
  let windowFrames = 0;
  let frameStartAt = NaN;
  const marks = [NaN, NaN, NaN, NaN]; // tick, render end, renderFrame end, swap end
  const guestEnter = new Array(GUEST_SLOTS).fill(NaN);
  const guestSpan = new Float64Array(GUEST_SLOTS);
  let frameNodes = 0, frameRecords = 0;
  let gcCount = 0, gcPauseMs = 0;
  let lastSampleAt = now();
  let observer = null;

  if (observeGc) {
    try {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) { gcCount++; gcPauseMs += entry.duration; }
      });
      observer.observe({ entryTypes: ['gc'] });
    } catch (_) {
      observer = null;
    }
  }

  const guest = {
    enter(slot) { guestEnter[slot] = now(); },
    leave(slot) {
      const started = guestEnter[slot];
      if (started === started) {
        guestSpan[slot] += now() - started;
        guestEnter[slot] = NaN;
      }
    },
    addNodes(count) { frameNodes += count; },
    addRecords(count) { frameRecords += count; }
  };

  function publish(summary) {
    try {
      const pmjs = globalThis.PMJS;
      if (pmjs) {
        pmjs.stats = pmjs.stats || {};
        pmjs.stats.frame = summary;
      }
    } catch (_) {}
  }

  function sample(atMs) {
    if (!windowFrames) { lastSampleAt = atMs; return null; }
    const previousSampleAt = lastSampleAt;
    const frames = windowFrames;
    const gc = { count: gcCount, pauseMs: Math.round(gcPauseMs * 1000) / 1000 };
    // Reset the window first: one broken sample must never wedge the frame loop or repeat.
    windowFrames = 0;
    gcCount = 0;
    gcPauseMs = 0;
    lastSampleAt = atMs;
    try {
      const span = Math.max(1, atMs - previousSampleAt);
      const summary = {
        type: 'frame-stats',
        time: new Date().toISOString(),
        frames,
        elapsedMs: Math.round(span),
        fps: Math.round(frames * 1000 / span * 100) / 100,
        phases: {},
        nodes: percentiles(nodeRows, frames),
        records: percentiles(recordRows, frames),
        gc,
        memory: (() => {
          const usage = memoryUsage();
          return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, externalBytes: usage.external };
        })()
      };
      for (let phase = 0; phase < PHASES.length; phase++) {
        summary.phases[PHASES[phase]] = percentiles(rows[phase], frames);
      }
      publish(summary);
      write(JSON.stringify(summary) + '\n');
      return summary;
    } catch (error) {
      const message = '[pmjs] frame stats sample failed: ' + error.message;
      // Same rule as diagnostics: never call a guest-patched console method.
      if (logger === hostConsole) { try { fs.writeSync(2, message + '\n'); } catch (_) {} }
      else logger.warn(message);
      return null;
    }
  }

  return {
    guest,
    frameStart() {
      frameStartAt = now();
      for (let index = 0; index < marks.length; index++) marks[index] = NaN;
      for (let slot = 0; slot < GUEST_SLOTS; slot++) {
        guestEnter[slot] = NaN;
        guestSpan[slot] = 0;
      }
      frameNodes = 0;
      frameRecords = 0;
    },
    markTick() { marks[0] = now(); },
    markRender() { marks[1] = now(); },
    markRenderFrame() { marks[2] = now(); },
    markSwap() { marks[3] = now(); },
    frameEnd() {
      if (frameStartAt !== frameStartAt) return;
      const [tickAt, renderAt, renderFrameAt, swapAt] = marks;
      if (tickAt !== tickAt || renderAt !== renderAt || renderFrameAt !== renderFrameAt ||
          swapAt !== swapAt) return;
      const atMs = now();
      // Emit the window before the next write would exceed the buffers.
      if (windowFrames >= capacity) sample(atMs);
      const index = windowFrames;
      rows[0][index] = tickAt - frameStartAt;
      rows[1][index] = renderAt - tickAt;
      rows[2][index] = guestSpan[PREPARE_SLOT];
      rows[3][index] = guestSpan[ENCODE_SLOT];
      rows[4][index] = guestSpan[SUBMIT_SLOT];
      rows[5][index] = renderFrameAt - renderAt;
      rows[6][index] = swapAt - renderFrameAt;
      nodeRows[index] = frameNodes;
      recordRows[index] = frameRecords;
      windowFrames++;
      if (atMs - lastSampleAt >= intervalMs) sample(atMs);
    },
    stop() {
      if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
      const summary = sample(now());
      if (globalThis.pmjsFrameStats === guest) globalThis.pmjsFrameStats = undefined;
      return summary;
    }
  };
}

module.exports = { createFrameStats, PHASES, percentiles };
