'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const { spritePacket, drawPacket } = require('./helpers/sparse-palette.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('prepared-linear-palette-');
const budget = process.argv.includes('--disabled') ? 0 : process.argv.includes('--small-budget') ? 64 : null;
const pixels = Buffer.alloc(64 * 48 * 4);
for (let y = 3; y < 45; y++) for (let x = 4; x < 60; x++) {
  const gray = (x + y) % 17 * 15;
  pixels.set([gray, gray, gray, x % 5 * 51], (y * 64 + x) * 4);
}
const bytes = png(64, 48, pixels);
fs.writeFileSync(path.join(root, 'source.png'), bytes);
const sheetPixels = Buffer.alloc(192 * 64 * 4);
for (let i = 0; i < sheetPixels.length; i += 4) {
  const value = i / 4;
  sheetPixels.set([value % 251, value * 53 % 251, 37, value % 3 * 127], i);
}
fs.writeFileSync(path.join(root, 'sheet.png'), png(192, 64, sheetPixels));
native.initialize({ gameRoot: root, width: 96, height: 80, windowTitle: 'Prepared linear palette', imageWarmCacheBytes: 0,
  ...(budget === null ? {} : { preparedFrameCacheBytes: budget }) });
let reference, prepared;
async function classifiedSheet() {
  const directory = path.join(root, 'sheet'); fs.mkdirSync(directory);
  const descriptor = await native.assets.processImage('sheet.png', directory,
    { grid: [3, 1], backdrop: [0, 0, 0, 0] });
  const storage = await native.assets.classifyImageStorage(path.join(root, 'sheet.png'));
  assert.ok(storage.paletteBits);
  const sourceIdentity = native.assets.sourceIdentity('sheet.png');
  assert.equal(native.assets.installImageStorage([{ source: 'sheet.png', sourceIdentity, storage }]), 1);
  assert.equal(native.assets.installPrepared([{ source: 'sheet.png', sourceIdentity, directory, descriptor }]), 1);
  const image = await native.images.loadAsync('sheet.png');
  const reference = native.canvas.create(192, 64);
  try {
    native.canvas.writePixels(reference.handle, 0, 0, 192, 64, sheetPixels);
    const options = { nearest: false, crop: [0, 0, 128, 64], scale: 0.7 };
    const actual = drawPacket(native, spritePacket(native, image, options));
    const expected = drawPacket(native, spritePacket(native, reference, { ...options, premultiplied: true }));
    let maximum = 0;
    for (let i = 0; i < actual.length; ++i) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
    assert.ok(maximum <= 1, 'classified frame changed ordinary filtering');
    const owner = () => native.images.memory(100).largest.find(entry => entry.handle === image.handle);
    assert.equal(owner().fullTextureResident, budget !== null,
      'an eligible frame must not allocate the full source palette');
    drawPacket(native, spritePacket(native, image, { ...options, nearest: true }));
    assert.equal(owner().fullTextureResident, true, 'nearest drawing must retain the full palette fallback');
  } finally {
    native.images.release(image.handle);
    native.canvas.release(reference.handle);
    native.beginFrame();
  }
}
(async () => {
  try {
    const directory = path.join(root, 'prepared'); fs.mkdirSync(directory);
    const descriptor = await native.assets.processImage('source.png', directory, { grid: [1, 1], backdrop: [0, 0, 0, 0] });
    assert.ok(descriptor);
    native.assets.installPrepared([{ source: 'source.png', directory, descriptor,
      sourceIdentity: native.assets.sourceIdentity('source.png') }]);
    reference = native.canvas.create(64, 48);
    native.canvas.writePixels(reference.handle, 0, 0, 64, 48, pixels);
    prepared = await native.images.loadAsync('source.png');
    native.render.setClearColor(0.1, 0.2, 0.3, 0.6);
    const memory = () => native.images.memory(100);
    drawPacket(native, spritePacket(native, prepared, { crop: [0, 0, 64, 48] }));
    assert.equal(memory().preparedFrameCacheMisses, 0, 'nearest sprites retain the indexed path');
    for (const scale of [0.98, 1.25]) for (const crop of [[0, 0, 64, 48], [0.25, 0.5, 60.5, 44.5]]) {
      const options = { nearest: false, scale, crop };
      const expected = drawPacket(native, spritePacket(native, reference, { ...options, premultiplied: true }));
      const actual = drawPacket(native, spritePacket(native, prepared, options));
      if (budget === null && scale === 0.98 && crop[0] === 0)
        assert.ok(memory().preparedFrameCacheBytes < 64 * 48 * 2,
          'converted frames must trim zero margins while retaining the filter halo');
      let maximum = 0;
      for (let i = 0; i < actual.length; i++) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
      assert.ok(maximum <= 1, `ordinary filtering rounding exceeded one byte: ${maximum}`);
    }
    if (budget !== null) {
      assert.equal(memory().preparedFrameCacheMisses, 0);
      assert.equal(memory().preparedFrameCacheBytes, 0);
      await classifiedSheet();
      return;
    }
    assert.ok(memory().preparedFrameCacheMisses > 0);
    const packet = spritePacket(native, prepared, { nearest: false, crop: [0, 0, 64, 48] });
    const first = drawPacket(native, packet), uploads = memory().textureUploadBytes, hits = memory().preparedFrameCacheHits;
    assert.deepEqual(drawPacket(native, packet), first);
    assert.ok(memory().preparedFrameCacheHits > hits);
    assert.equal(memory().textureUploadBytes, uploads);
    assert.ok(memory().preparedFrameCacheBytes <= memory().preparedFrameCacheBudget);
    native.images.release(prepared.handle); prepared = null; native.beginFrame();
    assert.equal(memory().preparedFrameCacheBytes, 0, 'source release must clear converted frames');
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3])
      pixels[i] = pixels[i + 1] = pixels[i + 2] = (pixels[i] + 47) % 256;
    fs.writeFileSync(path.join(root, 'source.png'), png(64, 48, pixels));
    const replacementDirectory = path.join(root, 'replacement'); fs.mkdirSync(replacementDirectory);
    const replacement = await native.assets.processImage('source.png', replacementDirectory, { grid: [1, 1], backdrop: [0, 0, 0, 0] });
    assert.ok(replacement);
    native.assets.installPrepared([{ source: 'source.png', directory: replacementDirectory, descriptor: replacement,
      sourceIdentity: native.assets.sourceIdentity('source.png') }]);
    prepared = await native.images.loadAsync('source.png');
    native.canvas.writePixels(reference.handle, 0, 0, 64, 48, pixels);
    const replaced = drawPacket(native, spritePacket(native, prepared, { nearest: false, crop: [0, 0, 64, 48] }));
    const expected = drawPacket(native, spritePacket(native, reference, { nearest: false, premultiplied: true, crop: [0, 0, 64, 48] }));
    assert.notDeepEqual(replaced, first);
    let maximum = 0;
    for (let i = 0; i < replaced.length; i++) maximum = Math.max(maximum, Math.abs(replaced[i] - expected[i]));
    assert.ok(maximum <= 1, 'replacement must use new source pixels');
    await classifiedSheet();
  } finally {
    if (prepared) native.images.release(prepared.handle);
    if (reference) native.canvas.release(reference.handle);
    native.runtime.quit();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
