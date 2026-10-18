'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const HASH = /^[a-f0-9]{64}$/;

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return null; }
}
async function writeJson(file, data, flush = true) {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(JSON.stringify(data) + '\n');
    if (flush) await handle.sync();
  } finally { await handle.close(); }
}
const activeLeases = new Map();
let exitCleanupInstalled = false;

function processStart(pid) {
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
  } catch (_) { return null; }
}
function ownerAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
  if (owner.hostname !== os.hostname()) return true;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code !== 'ESRCH'; }
  const start = processStart(owner.pid);
  return !owner.start || !start || owner.start === start;
}
async function createLease(cacheRoot, keys) {
  const file = path.join(cacheRoot, `.lease-${process.pid}-${crypto.randomBytes(8).toString('hex')}.json`);
  // The preparation lock serializes every lease reader and writer, so page-cache
  // visibility is sufficient: leases only protect live processes, making them
  // meaningless after a crash that durability would survive. Skipping fsync here
  // removes one slow sync per launch without weakening cleanup safety.
  await writeJson(file, { pid: process.pid, hostname: os.hostname(), start: processStart(process.pid), keys }, false);
  function release() {
    activeLeases.delete(file);
    try { fs.unlinkSync(file); } catch (_) {}
  }
  activeLeases.set(file, release);
  if (!exitCleanupInstalled) {
    process.once('exit', () => { for (const release of [...activeLeases.values()]) release(); });
    exitCleanupInstalled = true;
  }
  return release;
}
async function retainLeases(cacheRoot, retained) {
  for (const filename of await fsp.readdir(cacheRoot)) {
    if (!/^\.lease-\d+-[a-f0-9]+\.json$/.test(filename)) continue;
    const file = path.join(cacheRoot, filename);
    const lease = await readJson(file);
    if (!ownerAlive(lease) || !Array.isArray(lease.keys)) {
      await fsp.rm(file, { force: true });
      continue;
    }
    for (const key of lease.keys) if (HASH.test(key)) retained.add(key);
  }
}
async function acquireLock(cacheRoot, cancelled, onWait, assets, waitMilliseconds = 15000) {
  if (typeof assets?.tryAcquirePreparationLock !== 'function' ||
      typeof assets?.releasePreparationLock !== 'function')
    throw new Error('kernel preparation locking is unavailable');
  const started = performance.now();
  for (;;) {
    if (cancelled()) return null;
    const token = assets.tryAcquirePreparationLock(cacheRoot);
    if (token) return () => assets.releasePreparationLock(token);
    if (performance.now() - started >= waitMilliseconds)
      throw new Error('preparation cache lock wait timed out');
    onWait();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

module.exports = { acquireLock, createLease, retainLeases };
