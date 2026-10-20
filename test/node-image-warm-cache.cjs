'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('warm-cache-');
const pixels = [17, 31, 49, 63, 79, 97, 113, 127, 139, 151, 173, 191, 211, 223, 239, 251];
for (const name of ['fixture.png', 'lease.png', 'retained-fixture.png'])
  fs.writeFileSync(path.join(root, name), png(2, 2, pixels));
native.initialize({ gameRoot: root, assetRoot: '',
  width: 640, height: 480, windowTitle: 'pmjs test', imageWarmCacheBytes: 16 });

function entry(handle) {
  return native.images.memory(20).largest.find(item => item.handle === handle);
}

async function main() {
  const first = await native.images.loadAsync('fixture.png');
  native.images.release(first.handle);
  native.beginFrame();
  let memory = native.images.memory(20);
  if (memory.warmBudgetBytes !== 16 || memory.warmBytes !== 16 ||
      memory.warmCount !== 1 || !entry(first.handle).warm) {
    throw new Error('released image did not enter the warm cache: ' +
      JSON.stringify(memory));
  }

  const reused = await native.images.loadAsync('fixture.png');
  memory = native.images.memory(20);
  if (reused.handle !== first.handle || memory.decodeJobs !== 1 ||
      memory.cacheHits !== 1 || memory.warmHits !== 1) {
    throw new Error('warm acquisition did not reuse the native handle: ' +
      JSON.stringify(memory));
  }
  native.images.release(reused.handle);

  const older = await native.images.loadAsync('lease.png');
  native.images.release(older.handle);
  native.images.touch(first.handle);
  native.beginFrame();
  memory = native.images.memory(20);
  if (entry(older.handle) || !entry(first.handle) || memory.warmBytes !== 16 ||
      memory.budgetEvictions !== 1) {
    throw new Error('touch did not protect the most-recently-used image: ' +
      JSON.stringify(memory));
  }

  native.images.pin(first.handle);
  native.images.pin(first.handle);
  const competing = await native.images.loadAsync('retained-fixture.png');
  native.images.release(competing.handle);
  native.beginFrame();
  memory = native.images.memory(20);
  if (!entry(first.handle) || !entry(competing.handle) ||
      memory.pinnedCount !== 1 || memory.pinnedBytes !== 16 ||
      memory.warmBytes !== 16) {
    throw new Error('pinned image incorrectly consumed or lost warm budget: ' +
      JSON.stringify(memory));
  }

  native.images.unpin(first.handle);
  if (entry(first.handle).pins !== 1) throw new Error('pin count was not balanced');
  native.images.unpin(first.handle);
  native.beginFrame();
  memory = native.images.memory(20);
  if (entry(first.handle) || !entry(competing.handle) ||
      memory.budgetEvictions !== 2) {
    throw new Error('final unpin did not restore budget eviction: ' +
      JSON.stringify(memory));
  }
  try {
    native.images.unpin(competing.handle);
    throw new Error('unbalanced unpin unexpectedly succeeded');
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  try {
    native.images.unpin(first.handle);
    throw new Error('stale handle unpin unexpectedly succeeded');
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }

  const final = await native.images.loadAsync('fixture.png');
  if (final.handle === first.handle) {
    throw new Error('evicted image retained its stale generation handle');
  }
  native.images.release(final.handle);
  console.log('[pmjs-node-image-warm-cache] ready');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
