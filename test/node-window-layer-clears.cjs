'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '',
  width: 64, height: 64, windowTitle: 'isolated rectangle clears' });
const schema = native.scene.schema;
assert.equal(schema.isolatedClearRect, true);
const white = native.canvas.create(1, 1);
native.canvas.writePixels(white.handle, 0, 0, 1, 1, Uint8Array.from([255, 255, 255, 255]));

function record(kind, tint = 0xffffff, x = 0, y = 0, width = 32, height = 32) {
  const metadata = [kind, 0xffffffff, kind === 1 ? white.handle : 0, tint, kind === 6 ? 20 : 0, 0, 0];
  const values = new Float32Array(schema.valueStride);
  values.set([1, 0, 0, 1, 0, 0, 1]);
  if (kind === 6) values[7] = 1;
  else {
    if (kind === 1) values.set([width, 0, 0, height, x, y]);
    else values.set([x, y], 7);
    values.set([0, 0, 1, 1], 9);
    values.set([width, height], 13);
  }
  return { metadata, values };
}
function submit(records) {
  const metadata = Uint32Array.from(records.flatMap(entry => entry.metadata));
  const values = new Float32Array(schema.valueStride * records.length);
  records.forEach((entry, index) => values.set(entry.values, index * schema.valueStride));
  native.scene.submit(schema.version, metadata, values, records.length);
}
const background = record(1, 0x0000ff, 0, 0, 64, 64);
const scene = [background, record(6), record(1, 0xff0000),
  record(10, 0, 8, 8, 16, 16), record(1, 0x00ff00, 16, 16, 16, 16), record(7)];
function pixels() {
  native.renderScene();
  return Buffer.from(native.canvas.captureSceneRawPremultiplied());
}
function pixel(buffer, x, y) { return Array.from(buffer.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)); }
native.beginFrame();
submit(scene);
const expected = pixels();
assert.deepEqual(pixel(expected, 4, 4), [255, 0, 0, 255]);
assert.deepEqual(pixel(expected, 12, 12), [0, 0, 255, 255], 'transparent clear exposes the main scene');
assert.deepEqual(pixel(expected, 20, 20), [0, 255, 0, 255], 'later draws follow the clear');
assert.deepEqual(pixel(expected, 40, 40), [0, 0, 255, 255]);
const invalidClears = [record(10, 0, 0, 0, -1, 1), record(10), record(10), record(10), record(10)];
invalidClears[1].values[33] = 17;
invalidClears[2].values[7] = NaN;
invalidClears[3].metadata[2] = white.handle;
invalidClears[4].metadata[5] = 524288;
const invalidPackets = [[background, record(10)], ...invalidClears.map(invalid =>
  [background, record(6), invalid, record(7)])];
for (const invalid of invalidPackets) {
  native.beginFrame();
  submit(scene);
  assert.throws(() => submit(invalid));
  assert.equal(pixels().equals(expected), true, 'invalid clear leaves the accepted scene transaction intact');
}
const nested = [background, record(6), record(1, 0xff0000), record(6),
  record(1, 0x00ff00), record(10, 0, 8, 8, 16, 16), record(7), record(7)];
submit(nested);
assert.deepEqual(pixel(pixels(), 12, 12), [255, 0, 0, 255], 'nested clear only erases the innermost target');
submit([background, record(6), record(1, 0xff0000), record(10, 0, 8.75, 8.5, 15.5, 15.5), record(7)]);
const fractional = pixels();
assert.deepEqual(pixel(fractional, 8, 8), [0, 0, 255, 255], 'scissor origin truncates fractional coordinates');
assert.deepEqual(pixel(fractional, 22, 22), [0, 0, 255, 255]);
assert.deepEqual(pixel(fractional, 23, 23), [255, 0, 0, 255], 'scissor extent truncates independently of its origin');
native.canvas.release(white.handle);
native.runtime.quit();
console.log('Isolated clears preserve ordered composition and reject root clears transactionally');
