'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 64, height: 64,
  windowTitle: 'Canvas image batches' });
const source = native.canvas.create(192, 96);
const pixels = new Uint8Array(192 * 96 * 4);
for (let y = 0; y < 96; y++) for (let x = 0; x < 192; x++)
  pixels.set([x, y * 2, (x + y) % 256, 64 + (x * 7 + y) % 192], (y * 192 + x) * 4);
native.canvas.writePixels(source.handle, 0, 0, 192, 96, pixels);
const rows = [
  [120,0,48,24,24,0,52,24,1], [120,72,48,24,24,56,52,24,1],
  [96,24,24,48,0,24,24,32,1], [168,24,24,48,76,24,24,32,1],
  [96,0,24,24,0,0,24,24,0], [168,0,24,24,76,0,24,24,0],
  [96,72,24,24,0,56,24,24,0], [168,72,24,24,76,56,24,24,0]
];
for (const alpha of [1, 0.4]) {
  const sequential = native.canvas.create(100,80), batched = native.canvas.create(100,80);
  for (const r of rows) native.canvas.drawImage(sequential.handle, source.handle, ...r.slice(0,8), alpha, !!r[8]);
  const backing = new Float32Array(9 + rows.length * 9);
  backing.set(rows.flat(), 9);
  native.canvas.drawImageBatch(batched.handle, source.handle, backing.subarray(9), alpha);
  assert.deepEqual(native.canvas.readPixels(batched.handle,0,0,100,80),
    native.canvas.readPixels(sequential.handle,0,0,100,80));
  native.canvas.release(sequential.handle); native.canvas.release(batched.handle);
}
const destination = native.canvas.create(100,80);
const before = native.canvas.readPixels(destination.handle,0,0,100,80);
for (const packet of [new Float32Array(8), new Float64Array(rows.flat()),
  new Float32Array([...rows[0], 0,0,1,1,0,0,-1,1,1]),
  new Float32Array([...rows[0], 0,0,1,1,0,0,1,1,NaN])]) {
  assert.throws(() => native.canvas.drawImageBatch(destination.handle,source.handle,packet,1));
  assert.deepEqual(native.canvas.readPixels(destination.handle,0,0,100,80), before);
}
const deferred = native.canvas.create(100,80);
native.canvas.drawImageBatch(deferred.handle,source.handle,new Float32Array(rows.flat()),1);
native.canvas.release(source.handle);
assert.ok(native.canvas.readPixels(deferred.handle,0,0,100,80).some(Boolean), 'queued batch retains its source');
native.canvas.release(deferred.handle); native.canvas.release(destination.handle);
console.log('image batch pixels, validation and source lifetime passed');
