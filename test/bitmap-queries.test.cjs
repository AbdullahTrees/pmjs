'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMvBlurContext } = require('./helpers/mv-blur-context.cjs');

function harness() {
  const reads = [];
  let extent;
  const native = { runtime: { env: () => '' }, canvas: {
    create(width, height) { extent = { width, height }; return { handle: 7, width, height }; }, release() {},
    fillRect() {}, clear() {}, drawImage() {}, compositePixels() {},
    readPremultipliedPixels(_handle, _x, _y, width, height) { return new Uint8ClampedArray(width * height * 4); },
    pixel(handle, x, y) {
      reads.push([handle, x, y]);
      if (x < 0 || y < 0 || x >= extent.width || y >= extent.height) throw new RangeError('invalid pixel');
      return x === 0 && y === 0 ? 0x12345678 : 0;
    },
    readPixels(_handle, x, y, width, height) {
      const pixels = new Uint8Array(width * height * 4);
      if (x === 0 && y === 0) pixels.set([0x12, 0x34, 0x56, 0x78]);
      return pixels;
    }
  } };
  return { context: createMvBlurContext(native), native, reads };
}

test('Bitmap measurement preserves Canvas hooks and restores the font', () => {
  const { context } = harness();
  const bitmap = new context.Bitmap(2, 2);
  const calls = [];
  const drawing = bitmap._context;
  drawing.font = '12px GameFont';
  drawing.measureText = function(text) {
    calls.push([text, this.font]);
    return { width: 120 };
  };
  assert.equal(bitmap.measureTextWidth('text'), 120);
  assert.deepEqual(calls, [['text', '24px GameFont']]);
  assert.equal(drawing.font, '12px GameFont');
});

test('Bitmap pixel coordinates match Canvas conversion before and after native allocation', () => {
  const { context, reads } = harness();
  const bitmap = new context.Bitmap(2, 2);
  assert.equal(bitmap.getPixel(-0.3, -0.7), '#123456');
  assert.equal(bitmap.getAlphaPixel(-0.3, -0.7), 0x78);
  assert.equal(bitmap.getPixel(-1.3, 0), '#000000');
  let conversions = 0;
  assert.equal(bitmap.getPixel({ valueOf() { conversions++; return -0.3; } }, 0), '#123456');
  assert.equal(conversions, 1);
  assert.deepEqual(reads.at(-1), [7, 0, 0]);
});

test('Bitmap readback errors propagate unchanged instead of becoming colors', () => {
  const { context, native } = harness();
  const bitmap = new context.Bitmap(2, 2);
  const error = new Error('readback failed');
  bitmap._context.getImageData = () => { throw error; };
  assert.throws(() => bitmap.getPixel(0, 0), caught => caught === error);
  bitmap._canvas._ensureNativeCanvas();
  native.canvas.pixel = () => { throw error; };
  assert.throws(() => bitmap.getAlphaPixel(0, 0), caught => caught === error);
});

test('Bitmap reads outside its canvas stay transparent after native allocation', () => {
  const { context, reads } = harness();
  const bitmap = new context.Bitmap(1, 1);
  assert.equal(bitmap.getPixel(162, 174), '#000000');
  assert.ok(bitmap._canvas._nativeCanvas);
  for (const [x, y] of [[162, 174], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
    assert.equal(bitmap.getPixel(x, y), '#000000');
    assert.equal(bitmap.getAlphaPixel(x, y), 0);
  }
  assert.deepEqual(reads, [], 'out-of-bounds reads must not call the rejecting native pixel API');
  let convertedX = 0, convertedY = 0;
  assert.equal(bitmap.getPixel({ valueOf() { ++convertedX; return 1.8; } },
    { valueOf() { ++convertedY; return -0.5; } }), '#000000');
  assert.equal(convertedX, 1);
  assert.equal(convertedY, 1);
});

test('unit full-bitmap fills establish revision-bound mask proof', () => {
  const { context } = harness();
  const { Bitmap, PMJS } = context;
  const bitmap = new Bitmap(100, 92);
  bitmap.fillAll('white');
  assert.deepEqual({ ...PMJS.web.canvas.unitMaskRect(bitmap._canvas) }, {
    x: 0, y: 0, width: 100, height: 92
  });
  bitmap._context.fillRect(0, 0, 1, 1);
  assert.equal(PMJS.web.canvas.unitMaskRect(bitmap._canvas), null);
  bitmap.fillAll('white');
  bitmap.blur();
  assert.equal(PMJS.web.canvas.unitMaskRect(bitmap._canvas), null);
});

test('mask proof rejects partial, translucent, transformed, clipped, and composited fills', () => {
  const { context: realm } = harness();
  const { Bitmap, PMJS } = realm;
  const bitmap = new Bitmap(100, 92);
  const context = bitmap._context;
  const reject = (prepare, color = 'white') => {
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context._transform = [1, 0, 0, 1, 0, 0];
    context._clipPaths = [];
    prepare();
    bitmap.fillRect(0, 0, 100, 92, color);
    assert.equal(PMJS.web.canvas.unitMaskRect(bitmap._canvas), null);
  };
  bitmap.fillRect(0, 0, 99, 92, 'white');
  assert.equal(PMJS.web.canvas.unitMaskRect(bitmap._canvas), null);
  reject(() => {}, 'rgba(255, 255, 255, 0.5)');
  reject(() => { context.globalAlpha = 0.5; });
  reject(() => { context.globalCompositeOperation = 'copy'; });
  reject(() => { context._transform[4] = 1; });
  reject(() => { context.beginPath(); context.rect(0, 0, 50, 92); context.clip(); });
});
