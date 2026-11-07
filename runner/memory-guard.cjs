'use strict';

// Once-a-second memory monitor for low-memory handhelds.
//
// - Writes one JSON line per second (RSS, available memory, V8 heap, native image bytes, the
//   current scene/map) to PMJS_MEMORY_LOG, synced to storage every few seconds so the tail
//   survives a power-off after a system freeze.
// - Culls when the process is large and still growing: the guest drops cached images it does
//   not currently hold (globalThis.__pmjsMemoryCull, installed by the MV layer), V8 runs a full
//   collection so dropped bitmaps release their native images, and the allocator is trimmed.
//
// Enabled when PMJS_MEMORY_GUARD=1 or PMJS_MEMORY_LOG is set. Two independent triggers:
// - safety net: available memory below PMJS_MEMORY_CRITICAL_MB culls whatever the RSS;
// - growth: RSS above PMJS_MEMORY_CULL_MB that grew since the last cull.
// Tunables (environment):
//   PMJS_MEMORY_CRITICAL_MB      available memory below which culls run (default 96; 0 disables)
//   PMJS_MEMORY_CULL_MB          RSS above which growth culls may run (default 500; 0 disables)
//   PMJS_MEMORY_CULL_GROWTH_MB   growth since the last cull that re-arms it (default 32)
//   PMJS_MEMORY_CULL_INTERVAL_MS minimum time between culls (default 5000)
//   PMJS_MEMORY_LOG_SYNC_MS      how often the log is synced to storage (default 5000)
const fs = require('node:fs');
const MiB = 1024 * 1024;

function numberFrom(env, name, fallback) {
  const value = Number(env[name]);
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function mb(bytes) { return typeof bytes === 'number' && Number.isFinite(bytes) ? Math.round(bytes / 1048576) : null; }

function createMemoryGuard({ native, readMemory, readHeap, now, env = {}, guest = globalThis,
  fileSystem = fs, collectGarbage = null, logger = console }) {
  const enabled = env.PMJS_MEMORY_GUARD === '1' || Boolean(env.PMJS_MEMORY_LOG);
  const cullBytes = numberFrom(env, 'PMJS_MEMORY_CULL_MB', 500) * MiB;
  const criticalBytes = numberFrom(env, 'PMJS_MEMORY_CRITICAL_MB', 96) * MiB;
  const growthBytes = numberFrom(env, 'PMJS_MEMORY_CULL_GROWTH_MB', 32) * MiB;
  const cullIntervalMs = numberFrom(env, 'PMJS_MEMORY_CULL_INTERVAL_MS', 5000);
  const syncIntervalMs = numberFrom(env, 'PMJS_MEMORY_LOG_SYNC_MS', 5000);
  let descriptor = null, lastSyncAt = -Infinity, lastCullAt = -Infinity, lastCullRss = 0;
  let culls = 0, timer = null, failed = false;

  if (enabled && env.PMJS_MEMORY_LOG) {
    try { descriptor = fileSystem.openSync(env.PMJS_MEMORY_LOG, 'a'); }
    catch (error) { logger.warn('[pmjs] memory-guard log unavailable: ' + error.message); }
  }

  function write(record) {
    if (descriptor === null) return;
    try {
      fileSystem.writeSync(descriptor, JSON.stringify(record) + '\n');
      const at = now();
      if (at - lastSyncAt >= syncIntervalMs) {
        lastSyncAt = at;
        fileSystem.fdatasyncSync(descriptor);
      }
    } catch (error) {
      logger.warn('[pmjs] memory-guard log failed: ' + error.message);
      try { fileSystem.closeSync(descriptor); } catch (_) {}
      descriptor = null;
    }
  }

  function context() {
    const result = {};
    try {
      const scene = guest.SceneManager && guest.SceneManager._scene;
      if (scene && scene.constructor) result.scene = scene.constructor.name;
      if (guest.$gameMap && typeof guest.$gameMap.mapId === 'function') result.map = guest.$gameMap.mapId();
      if (guest.$gameParty && typeof guest.$gameParty.size === 'function') result.party = guest.$gameParty.size();
    } catch (_) {}
    return result;
  }

  function images() {
    try {
      const memory = native.images && typeof native.images.memory === 'function' ? native.images.memory(0) : null;
      return memory ? { imgCpuMB: mb(memory.cpuBytes), imgGpuMB: mb(memory.gpuBytes), images: memory.liveCount,
        pendingDecodes: memory.pendingDecodeJobs } : {};
    } catch (_) { return {}; }
  }

  function cull(memory, reason) {
    const started = now();
    const result = { reason, beforeRssMB: mb(memory.rssBytes), availableMB: mb(memory.availableBytes) };
    try {
      if (typeof guest.__pmjsMemoryCull === 'function') result.guest = guest.__pmjsMemoryCull();
    } catch (error) { result.guestError = String(error && error.message || error); }
    try {
      if (typeof collectGarbage === 'function') { collectGarbage(); result.gc = true; }
    } catch (error) { result.gcError = String(error && error.message || error); }
    try {
      if (native.runtime && typeof native.runtime.trimAllocator === 'function') {
        result.trimmed = native.runtime.trimAllocator();
      }
    } catch (error) { result.trimError = String(error && error.message || error); }
    let after = null;
    try { after = readMemory(); } catch (_) {}
    if (after) {
      result.afterRssMB = mb(after.rssBytes);
      result.recoveredMB = mb(Math.max(0, memory.rssBytes - after.rssBytes));
    }
    result.durationMs = Math.round((now() - started) * 10) / 10;
    lastCullAt = now();
    lastCullRss = after ? after.rssBytes : memory.rssBytes;
    culls++;
    logger.log('[pmjs] memory-cull ' + JSON.stringify(result));
    return result;
  }

  const guard = {
    get enabled() { return enabled; },
    get culls() { return culls; },
    // One sample: log it, and cull when large and still growing (or critically low).
    sample() {
      if (!enabled || failed) return null;
      let memory;
      try { memory = readMemory(); }
      catch (error) {
        failed = true;
        logger.warn('[pmjs] memory-guard unavailable: ' + error.message);
        return null;
      }
      const at = now();
      const record = { t: Math.round(at), rssMB: mb(memory.rssBytes), availMB: mb(memory.availableBytes) };
      try { const heap = readHeap && readHeap(); if (heap) { record.heapMB = mb(heap.used); record.heapTotalMB = mb(heap.total); } }
      catch (_) {}
      Object.assign(record, images(), context());
      let culled = null;
      if (at - lastCullAt >= cullIntervalMs && !(record.pendingDecodes > 0)) {
        const critical = criticalBytes > 0 && memory.availableBytes < criticalBytes;
        const growth = cullBytes > 0 && memory.rssBytes > cullBytes && memory.rssBytes >= lastCullRss + growthBytes;
        if (critical || growth) {
          culled = cull(memory, critical ? 'critical-available' : 'rss-growth');
          record.cull = culled;
        }
      }
      write(record);
      return record;
    },
    start(timers, intervalMs = 1000) {
      if (!enabled || timer) return;
      timer = timers.setInterval(() => guard.sample(), intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop(timers) {
      if (timer) timers.clearInterval(timer);
      timer = null;
      if (descriptor !== null) {
        try { fileSystem.fdatasyncSync(descriptor); fileSystem.closeSync(descriptor); } catch (_) {}
        descriptor = null;
      }
    }
  };
  return guard;
}

// A full V8 collection, or null when the host cannot provide one.
function garbageCollector({ v8 = require('node:v8'), vm = require('node:vm'), host = globalThis } = {}) {
  if (typeof host.gc === 'function') return () => host.gc();
  try {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    if (typeof gc === 'function') return () => gc();
  } catch (_) {}
  return null;
}

module.exports = { createMemoryGuard, garbageCollector };
