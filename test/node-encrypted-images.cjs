'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));
const root = temporaryDirectory('encrypted-images-');
const key = '00112233445566778899aabbccddeeff';
const pixels = Buffer.alloc(32 * 48 * 4);
for (let y = 0; y < 48; ++y) for (let x = 0; x < 32; ++x)
  pixels.set(x % 16 > 4 && y % 16 > 5 ? [x * 7, y * 5, 93, 255] : [0, 0, 0, 0], (y * 32 + x) * 4);
const bytes = png(32, 48, pixels);
const encrypted = Buffer.concat([Buffer.from('5250474d560000000003010000000000', 'hex'), bytes]);
for (let i = 0; i < 16; ++i) encrypted[16 + i] ^= Buffer.from(key, 'hex')[i];
fs.writeFileSync(path.join(root, 'plain.png'), bytes);
fs.writeFileSync(path.join(root, 'encrypted.png_'), encrypted);
fs.writeFileSync(path.join(root, 'bad.png_'), Buffer.alloc(32));
fs.writeFileSync(path.join(root, 'short.png_'), Buffer.alloc(16));
native.initialize({ gameRoot: root, width: 64, height: 64, windowTitle: 'encrypted images', imageWarmCacheBytes: 0 });
async function main() {
  const ordinary = await native.images.loadAsync('plain.png', true);
  const viewed = await native.images.loadEncryptedAsync('encrypted.png_', key, true);
  assert.deepEqual([viewed.width, viewed.height], [ordinary.width, ordinary.height]);
  const canvas = native.canvas.create(32, 48);
  const capture = image => {
    native.canvas.clear(canvas.handle);
    native.canvas.drawImage(canvas.handle, image.handle, 0, 0, 32, 48, 0, 0, 32, 48, 1);
    return Buffer.from(native.canvas.readPixels(canvas.handle, 0, 0, 32, 48));
  };
  assert.deepEqual(capture(viewed), capture(ordinary));
  await assert.rejects(native.images.loadEncryptedAsync('encrypted.png_', 'ff'.repeat(16)), /decode|image/);
  await assert.rejects(native.images.loadEncryptedAsync('bad.png_', key), /decode|image/);
  for (const invalid of ['', 'z'.repeat(32), '0'.repeat(31)])
    assert.throws(() => native.images.loadEncryptedAsync('encrypted.png_', invalid), /key/);
  await assert.rejects(native.images.loadEncryptedAsync('short.png_', key), /decode|image/);
  const pending = native.images.loadEncryptedAsync('encrypted.png_', key, true);
  fs.renameSync(path.join(root, 'encrypted.png_'), path.join(root, 'old.png_'));
  fs.writeFileSync(path.join(root, 'encrypted.png_'), Buffer.alloc(32));
  const retained = await pending;
  assert.deepEqual(capture(retained), capture(ordinary), 'queued decoder retains the original opened source');
  for (const image of [ordinary, viewed, retained]) native.images.release(image.handle);
  native.canvas.release(canvas.handle);
  console.log('encrypted PNG pixels, decoding, wrong-key rejection and retained file lifetime passed');
}
main().then(() => native.runtime.quit(), error => {
  console.error(error); native.runtime.quit(); process.exit(1);
});
