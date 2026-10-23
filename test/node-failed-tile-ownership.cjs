'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { png } = require('./helpers/png.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const native = require(path.resolve(process.argv[2]));

assert.equal(process.env.UV_THREADPOOL_SIZE, '1');
const root = temporaryDirectory('failed-tiles-');
const modes = process.argv.includes('--quit-pending') ? ['quit-pending'] :
  ['success', 'fallback', 'rejection', 'retained-control'];
const pixels = Buffer.alloc(4 * 4 * 4);
for (let i = 0; i < 16; ++i) pixels.set([17 + i * 3, 71 + i, 123 - i, 255], i * 4);

// The sole worker stays in FIFO open while pending loads lose their last view.
async function withBlockedWorker(run) {
  const fifo = path.join(root, 'worker-barrier');
  execFileSync('mkfifo', [fifo]);
  const opened = new Promise((resolve, reject) => {
    fs.open(fifo, 'r', (error, fd) => {
      if (error) reject(error);
      else { fs.closeSync(fd); resolve(); }
    });
  });
  try { await run(); }
  finally {
    const writer = fs.openSync(fifo, fs.constants.O_RDWR);
    await opened;
    fs.closeSync(writer);
    fs.unlinkSync(fifo);
  }
}

function assertPixels(image) {
  const canvas = native.canvas.create(4, 4);
  try {
    native.canvas.drawImage(canvas.handle, image.handle, 0, 0, 4, 4, 0, 0, 4, 4, 1);
    assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 4, 4)), pixels);
  } finally { native.canvas.release(canvas.handle); }
}

async function main() {
  const fixtures = modes.map(name => {
    const source = name + '.png';
    const snapshot = path.join(root, name + '-snapshot.png');
    const directory = path.join(root, name + '-tiles');
    fs.writeFileSync(path.join(root, source), png(4, 4, pixels));
    fs.copyFileSync(path.join(root, source), snapshot);
    fs.mkdirSync(directory);
    return { name, source, snapshot, directory };
  });
  native.initialize({ gameRoot: root, width: 16, height: 16,
    windowTitle: 'failed tile ownership', imageWarmCacheBytes: 0 });
  // Prime the pinned fallback before checking that all temporary backing is gone.
  native.images.release(native.images.fallbackImage().handle);
  const initial = native.images.memory();
  for (const { name, source, snapshot, directory } of fixtures) {
    const descriptor = await native.assets.processTiles(
      [{ file: snapshot, rectangles: [[0, 0, 4, 4]] }], directory);
    Object.assign(descriptor.sources[0], {
      source, snapshot, sourceIdentity: native.assets.sourceIdentity(source),
    });
    assert.equal(native.assets.installTileSets([{ identity: name, directory, descriptor }]), 1);
    const original = await native.images.loadAsync(source, false, name);
    const loaded = native.images.memory();
    assert.ok(loaded.tileHits > initial.tileHits, 'initial tile view was installed');
    let outcomes, beforeCompletion;
    await withBlockedWorker(async () => {
      const first = native.images.loadAsync(source, true, name);
      const second = native.images.loadAsync(source, true, name);
      outcomes = Promise.allSettled([first, second]);
      let settled = false;
      outcomes.then(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'worker barrier must keep both loads pending');
      const queued = native.images.memory();
      assert.equal(queued.pendingDecodeJobs, 1);
      assert.equal(queued.decodeJobs - loaded.decodeJobs, 1);
      assert.equal(queued.coalescedRequests - loaded.coalescedRequests, 1);
      if (name !== 'retained-control') native.images.release(original.handle);
      native.assets.installTileSets([]);
      native.beginFrame();
      const pending = native.images.memory();
      assert.ok(pending.tileMetadataBytes > 0, 'pending load retains captured prototype');
      assert.ok(pending.gpuBytes > initial.gpuBytes, 'pending load retains GPU pages');
      if (name !== 'success') fs.writeFileSync(snapshot, 'corrupt snapshot');
      if (name === 'rejection') fs.writeFileSync(path.join(root, source), 'corrupt source');
      if (name === 'quit-pending') native.runtime.quit();
      beforeCompletion = native.images.memory();
    });
    const settled = await outcomes;
    assert.equal(native.images.memory().pendingDecodeJobs, 0);
    if (name === 'rejection') {
      for (const result of settled) {
        assert.equal(result.status, 'rejected');
        assert.match(result.reason.message, /cannot load image/);
      }
    } else {
      for (const result of settled) assert.equal(result.status, 'fulfilled');
      const [a, b] = settled.map(result => result.value);
      assert.equal(a.handle, b.handle);
      assert.notEqual(a, b);
      assertPixels(a);
      const entry = native.images.memory(100).largest.find(entry => entry.handle === a.handle);
      assert.equal(entry.references, 2, 'coalesced load owns two independent references');
      native.images.release(a.handle);
      native.images.release(b.handle);
    }
    if (name === 'retained-control') {
      assertPixels(original);
      native.images.release(original.handle);
    }
    native.beginFrame();
    const after = native.images.memory();
    assert.equal(after.liveCount, initial.liveCount, name + ' live handles cleaned');
    assert.equal(after.gpuBytes, initial.gpuBytes, name + ' GPU accounting cleaned');
    assert.equal(after.tileMetadataBytes, 0, name + ' captured metadata cleaned');
    assert.equal(after.warmFileCount, 0, name + ' warm file ownership cleaned');
    assert.equal(after.tileHits - beforeCompletion.tileHits, name === 'success' ? 1 : 0,
      'invalid prepared load must not install');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => { native.runtime.quit(); });
