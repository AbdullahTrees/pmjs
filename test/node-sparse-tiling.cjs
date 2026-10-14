'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {png} = require('./helpers/png.cjs');

if (!process.argv.includes('--worker')) {
  const results = [0, 1].map(enabled => {
    const child = spawnSync(process.execPath, [__filename, process.argv[2], '--worker'], {
      env: {...process.env, PMJS_SPARSE_TILING: String(enabled), PMJS_GRAPHICS_DIAGNOSTICS: '1'},
      encoding: 'utf8', timeout: 15000
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return JSON.parse(child.stdout.trim().split('\n').at(-1));
  });
  assert.deepEqual(results[1].hashes, results[0].hashes, 'sparse coverage preserves samples and following draws');
  assert.equal(results[0].stats.sparseTilingCommands, 0);
  assert.ok(results[1].stats.sparseTilingCommands > 0);
  assert.ok(results[1].stats.sparseTilingPixels < results[1].stats.sparseTilingFullPixels);
  assert.equal(results[1].finalCpuBytes, 0, 'sparse metadata releases with its image');
  console.log(JSON.stringify({comparisons: results[0].hashes.length, stats: results[1].stats}));
} else {
  const native = require(path.resolve(process.argv[2]));
  native.initialize({gameRoot: __dirname, width: 96, height: 80, imageWarmCacheBytes: 0,
    windowTitle: 'Sparse tiling coverage'});
  native.render.setClearColor(0.08, 0.15, 0.2, 1);
  const pixels = Buffer.alloc(193 * 159 * 4);
  for (let y = 0; y < 159; y++) for (let x = 0; x < 193; x++) {
    const visible = (x >= 32 && x < 45 && y >= 32 && y < 48) || (x > 187 && y > 153);
    pixels.set([255, 255, 255, visible ? 39 : 0], (y * 193 + x) * 4);
  }
  const image = native.images.loadBytes(png(193, 159, pixels));
  const icon = native.images.loadBytes(png(2, 2, Buffer.alloc(16, 255)));
  const schema = native.scene.schema, hashes = [];
  try {
    for (const nearest of [true, false]) {
      for (const [x, y, scale] of [[0, 0, 1], [31.5, 20.25, 1], [-191.25, -158.75, 0.25]]) {
        const metadata = new Uint32Array([2, 0xffffffff, image.handle, 0xffffff, 0,
          (nearest ? 8 : 0) | (1 << 15), 0, 1, 0xffffffff, icon.handle, 0xff0000, 0, 8, 0]);
        const values = new Float32Array(schema.valueStride * 2);
        values.set([1, 0, 0, 1, 0, 0, 0.73]);
        values.set([x, y, 96 / scale, 80 / scale, 96, 80], 9);
        values.set([1, 0, 0, 1, 20, 25, 1], schema.valueStride);
        values.set([0, 0, 2, 2, 2, 2], schema.valueStride + 9);
        native.beginFrame(); native.scene.submit(schema.version, metadata, values, 2); native.renderScene();
        hashes.push(crypto.createHash('sha256').update(
          Buffer.from(native.canvas.captureSceneRawPremultiplied())).digest('hex'));
      }
    }
    const isolatedPixels = Buffer.alloc(193 * 159 * 4);
    isolatedPixels.set([255, 255, 255, 39], (50 * 193 + 50) * 4);
    const isolated = native.images.loadBytes(png(193, 159, isolatedPixels));
    try {
      const metadata = new Uint32Array([2, 0xffffffff, isolated.handle, 0xffffff, 0, 32768, 0]);
      const values = new Float32Array(schema.valueStride);
      values.set([1, 0, 0, 1, 0, 0, 1]);
      values.set([0, 0, 1, 1e20, 96, 80], 9);
      native.beginFrame(); native.scene.submit(schema.version, metadata, values, 1); native.renderScene();
      native.render.finish();
    } finally {
      native.beginFrame(); native.scene.submit(schema.version, new Uint32Array(0), new Float32Array(0), 0);
      native.renderScene(); native.render.finish(); native.images.release(isolated.handle);
    }
    const stats = native.render.stats();
    native.beginFrame(); native.scene.submit(schema.version, new Uint32Array(0), new Float32Array(0), 0);
    native.renderScene(); native.render.finish();
    native.images.release(image.handle); native.images.release(icon.handle);
    console.log(JSON.stringify({hashes, stats, finalCpuBytes: native.images.memory().cpuBytes}));
  } finally { native.runtime.quit(); }
}
