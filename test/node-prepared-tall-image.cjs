'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('prepared-tall-');
const fixtures = [11200, 13488, 16384].map(height => {
  const width = 128, source = `tall-${height}.png`, pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x)
    pixels.set([y % 251, x * 13, (y + x) % 253, 255], (y * width + x) * 4);
  const bytes = png(width, height, pixels);
  fs.writeFileSync(path.join(root, source), bytes);
  return { source, width, height, bytes, pixels };
});
native.initialize({ gameRoot: root, width: 96, height: 80, windowTitle: 'Tall prepared images', imageWarmCacheBytes: 0 });
(async () => {
  try {
    for (const { source, width, height, bytes, pixels } of fixtures) {
      const directory = path.join(root, source + '-prepared'); fs.mkdirSync(directory);
      const descriptor = await native.assets.processImage(source, directory, { grid: [1, 1] },
        path.join(root, source), null, { pageCodec: 'lz4' });
      assert.equal(descriptor.height, height);
      assert.equal(descriptor.textureArtifact, 'texture.pmtx');
      assert.ok(descriptor.pages.every(page => page.width <= 2048 && page.height <= 2048));
      assert.equal(native.assets.installPrepared([{ source, directory, descriptor,
        sourceIdentity: native.assets.sourceIdentity(source) }]), 1);
      const reference = native.images.loadBytes(bytes), first = await native.images.loadAsync(source);
      const retained = await native.images.loadAsync(source);
      assert.equal(first.handle, retained.handle);
      assert.equal(native.images.memory(10).largest.find(entry => entry.handle === first.handle).cpuBytes, 0,
        'artifact validation must not retain decoded recovery pages');
      native.images.release(first.handle);
      const beforeDraw = native.images.memory();
      try {
        for (const y of [2027, 8177, height - 48]) for (const nearest of [true, false]) {
          const options = { nearest, crop: [0, y + 0.25, width, 47.5], scale: 0.97 };
          const expected = drawPacket(native, spritePacket(native, reference, options));
          const actual = drawPacket(native, spritePacket(native, retained, options));
          let maximum = 0;
          for (let i = 0; i < actual.length; ++i) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
          assert.ok(maximum <= (nearest ? 0 : 1), `tall image sampling delta ${maximum}`);
        }
        const drawn = native.images.memory();
        assert.equal(drawn.textureArtifactLoads, beforeDraw.textureArtifactLoads + 1);
        assert.equal(drawn.sourceTextureBuilds, beforeDraw.sourceTextureBuilds);
        assert.ok(drawn.textureArtifactStagingBytes <= 1024 * 1024);
        const canvas = native.canvas.create(width, 16);
        try {
          native.canvas.drawImage(canvas.handle, retained.handle, 0, height - 16, width, 16, 0, 0, width, 16, 1);
          assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, width, 16)), pixels.subarray((height - 16) * width * 4));
          native.canvas.writePixels(canvas.handle, 0, 0, 1, 1, Buffer.from([7, 11, 19, 255]));
          assert.deepEqual(Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 1, 1)), Buffer.from([7, 11, 19, 255]));
        } finally { native.canvas.release(canvas.handle); }
      } finally {
        native.images.release(reference.handle); native.images.release(retained.handle);
        drawPacket(native, { metadata: new Uint32Array(0), values: new Float32Array(0), count: 0 }, false);
      }
      const memory = native.images.memory();
      assert.equal(memory.cpuBytes, 0); assert.ok(memory.gpuBytes === 0 || memory.gpuBytes === 64);
    }
  } finally { native.runtime.quit(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
