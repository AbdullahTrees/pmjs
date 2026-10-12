'use strict';

process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 192, height: 96,
  windowTitle: 'rectangle presentation' });
native.images.memory();
const initialImages = native.images.memory().liveCount;
const overlay = native.canvas.create(8, 8);
const upper = native.canvas.create(192, 96);
native.canvas.fillRect(upper.handle, 0, 0, 192, 96, 0xff0000ff);
const colors = [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffff00ff];
colors.forEach((color, index) => native.canvas.fillRect(overlay.handle,
  index % 2 * 4, Math.floor(index / 2) * 4, 4, 4, color));
const show = (handle = overlay.handle, x = 10, y = 12, opacity = 1) =>
  native.render.setPresentationOverlay(handle, x, y, 32, 16, opacity);
function frame() {
  native.beginFrame();
  native.renderFrame();
}
function pixel(x, y) {
  const geometry = native.render.presentation();
  const shot = native.canvas.captureDrawable();
  try {
    return Array.from(native.canvas.readPixels(shot.handle,
      Math.floor(geometry.viewportX + x * geometry.viewportWidth / geometry.sourceWidth),
      Math.floor(geometry.viewportY + y * geometry.viewportHeight / geometry.sourceHeight), 1, 1));
  } finally { native.canvas.release(shot.handle); }
}
function check(actual, expected) {
  assert(actual.every((channel, index) => Math.abs(channel - expected[index]) <= 3),
    `${actual} versus ${expected}`);
}
native.beginFrame();
native.render.quad(0, 0, 192, 96, 1, 1, 1, 1);
native.renderFrame();
const before = native.render.stats();
const uploads = native.images.memory().textureUploadBytes;
show();
assert.equal(native.images.memory().textureUploadBytes - uploads, 8 * 8 * 4);
for (let index = 0; index < 3; index++) frame();
assert.equal(native.render.stats().commands, before.commands);
assert.equal(native.render.stats().retainedFrames, before.retainedFrames + 3);
assert.equal(native.render.stats().drawCalls - before.drawCalls, 3,
  'rectangle adds one draw per frame, without full-screen composition');
[[18, 16], [34, 16], [18, 24], [34, 24]].forEach(([x, y], index) =>
  check(pixel(x, y), [colors[index] >>> 24, colors[index] >>> 16 & 255,
    colors[index] >>> 8 & 255, 255]));
check(pixel(8, 16), [255, 255, 255, 255]);
const snapshot = native.canvas.captureScene();
assert.equal(native.canvas.pixel(snapshot.handle, 18, 16), 0xffffffff);
native.canvas.release(snapshot.handle);
const offscreen = native.canvas.create(192, 96);
native.beginFrame();
native.render.quad(0, 0, 192, 96, 1, 1, 1, 1);
native.render.renderToCanvas(offscreen.handle);
assert.equal(native.canvas.pixel(offscreen.handle, 18, 16), 0xffffffff);
native.canvas.release(offscreen.handle);

native.render.setPresentationLayers(1, 0, 0, upper.handle, 1);
show(overlay.handle, 10, 12, 0.5);
frame();
check(pixel(34, 16), [127, 128, 0, 255]);
check(pixel(80, 30), [255, 0, 0, 255]);
native.render.setPresentationLayers(1, 0, 0, 0, 0);
native.canvas.release(upper.handle);

native.canvas.fillRect(overlay.handle, 0, 0, 8, 8, 0x00ffffff);
const beforeMutation = native.images.memory().textureUploadBytes;
show();
assert.equal(native.images.memory().textureUploadBytes - beforeMutation, 8 * 8 * 4);
frame();
check(pixel(18, 16), [0, 255, 255, 255]);
show(overlay.handle, 10, 12, 0);
frame();
check(pixel(18, 16), [255, 255, 255, 255]);

const replacement = native.canvas.create(8, 8);
native.canvas.fillRect(replacement.handle, 0, 0, 8, 8, 0x0000ffff);
show(replacement.handle, -8, -4);
native.canvas.release(overlay.handle);
native.canvas.release(replacement.handle);
frame();
check(pixel(4, 4), [0, 0, 255, 255]);
assert.equal(native.images.memory().liveCount, initialImages + 1,
  'presentation retains the replacement after its canvas owner is released');
for (const geometry of [[NaN, 0, 32, 16, 1], [0, 0, 0, 16, 1],
  [0, 0, 32, 16, Infinity]]) {
  assert.throws(() => native.render.setPresentationOverlay(0, ...geometry), /finite geometry/);
}
assert.throws(() => show(0xffffffff), /invalid presentation overlay canvas/);
frame();
check(pixel(4, 4), [0, 0, 255, 255]);
const geometry = native.render.presentation();
if (geometry.letterboxed) {
  const shot = native.canvas.captureDrawable();
  const [x, y] = geometry.viewportX > 0 ? [0, Math.floor(shot.height / 2)] :
    [Math.floor(shot.width / 2), 0];
  assert.equal(native.canvas.pixel(shot.handle, x, y), 0x000000ff,
    'clipped overlay does not draw into letterbox bars');
  native.canvas.release(shot.handle);
}
native.render.setScreenRenderSize(208, 104);
native.beginFrame();
native.render.quad(0, 0, 208, 104, 1, 1, 1, 1);
native.renderFrame();
check(pixel(4, 4), [0, 0, 255, 255]);
show(0);
frame();
check(pixel(4, 4), [255, 255, 255, 255]);
assert.equal(native.images.memory().liveCount, initialImages,
  'clearing presentation releases its retained image');
console.log('Rectangle presentation: pixels, retention, snapshots, stacking, clipping and ownership pass');
