'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { makeBitmapTextHarness } = require('./helpers/bitmap-text-harness.cjs');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 32, windowTitle: 'Bitmap text contracts' });
const contexts = [false, true].map(enabled => makeBitmapTextHarness(native, enabled));
const pixels = bitmap => native.canvas.readPremultipliedPixels(bitmap._canvas._nativeCanvas.handle,
  0, 0, bitmap._canvas.width, bitmap._canvas.height);
let comparisons = 0;
const proofBitmap = new contexts[1].Bitmap(64, 32);
const proofContext = proofBitmap._context;
proofContext.fillStyle = 'white';
contexts[1].PMJS.web.canvas.trackMaskFill(proofContext, 0, 0, 64, 32, 'white',
  () => proofContext.fillRect(0, 0, 64, 32));
assert.ok(contexts[1].PMJS.web.canvas.unitMaskRect(proofBitmap._canvas));
const proofRevision = proofBitmap._canvas.__pmjsContentRevision;
proofBitmap.drawText('A', 0, 0, 64, 32, 'left');
assert.equal(proofBitmap._canvas.__pmjsContentRevision, proofRevision + 1);
assert.equal(proofBitmap.dirtyCount, 1);
assert.equal(contexts[1].PMJS.web.canvas.unitMaskRect(proofBitmap._canvas), null);
proofBitmap._canvas._releaseNativeCanvas();
for (const align of ['left', 'center', 'right']) for (const maxWidth of [0, 120, 280]) {
  for (const alpha of [1, 0.25]) for (const italic of [false, true]) for (const realized of [false, true]) {
    const frames = contexts.map(context => {
      const bitmap = new context.Bitmap(320, 96);
      bitmap.fontItalic = italic; bitmap.fontSize = 24.375;
      bitmap.outlineWidth = 3.75; bitmap.textColor = '#628ed080';
      bitmap._context.globalAlpha = alpha;
      bitmap._context.fillStyle = '#33557766'; bitmap._context.fillRect(0, 0, 320, 96);
      bitmap._context.font = '10px old-font'; bitmap._context.lineJoin = 'bevel';
      if (realized) pixels(bitmap);
      bitmap.drawText('AVATAR office ffi', 8.25, 8.5, maxWidth, 36, align);
      assert.equal(bitmap.dirtyCount, 1);
      assert.equal(bitmap._context.font, '10px old-font');
      assert.equal(bitmap._context.lineJoin, 'bevel');
      assert.equal(bitmap._context.globalAlpha, alpha);
      const frame = pixels(bitmap); bitmap._canvas._releaseNativeCanvas(); return frame;
    });
    assert.deepEqual(frames[0], frames[1], JSON.stringify({ align, maxWidth, alpha, italic, realized }));
    comparisons++;
  }
}

const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'assets/reference/canvas-regressions.json.gz'))));
require('../tools/generate-canvas-regressions-reference.cjs').validateFixture(oracle);
for (const align of ['left', 'center', 'right']) for (const alpha of [1, 0.5]) {
  const bitmap = new contexts[1].Bitmap(8, 8);
  bitmap.fontSize = 7; bitmap.outlineWidth = 1; bitmap.outlineColor = '#00000080';
  bitmap._context.globalAlpha = alpha;
  bitmap.drawText('AVATAR', 0, 0, 5, 7.1, align);
  const actual = pixels(bitmap), expected = oracle.frames['text/outlined-maxWidth/' + align + '/' + alpha];
  let maxDelta = 0;
  for (let i = 0; i < actual.length; i++) maxDelta = Math.max(maxDelta, Math.abs(actual[i] - expected[i]));
  assert.ok(maxDelta <= oracle.channelTolerance, align + '/' + alpha + ': ' + maxDelta);
  bitmap._canvas._releaseNativeCanvas(); comparisons++;
}

const bitmap = new contexts[1].Bitmap(320, 96);
bitmap._canvas._ensureNativeCanvas();
const canvasCount = native.canvas.memory().liveCount;
const create = native.canvas.create, draw = native.canvas.drawText, read = native.canvas.readPremultipliedPixels;
const measure = native.canvas.measureText;
native.canvas.create = native.canvas.drawText = native.canvas.readPremultipliedPixels = native.canvas.measureText = () => {
  throw new Error('Outlined text must stay inside one native call');
};
try { bitmap.drawText('W'.repeat(1000), 8, 8, 200, 36, 'center'); }
finally {
  native.canvas.create = create; native.canvas.drawText = draw;
  native.canvas.readPremultipliedPixels = read; native.canvas.measureText = measure;
}
assert.equal(native.canvas.memory().liveCount, canvasCount);
assert.ok(pixels(bitmap).some((value, i) => i % 4 === 3 && value));
const retained = native.canvas.create(320, 96);
native.canvas.drawImage(retained.handle, bitmap._canvas._nativeCanvas.handle, 0, 0, 320, 96, 0, 0, 320, 96, 1);
const frozen = pixels(bitmap);
bitmap.drawText('replacement', 0, 0, 200, 36, 'right');
bitmap._canvas._releaseNativeCanvas();
assert.deepEqual(native.canvas.readPremultipliedPixels(retained.handle, 0, 0, 320, 96), frozen);
native.canvas.release(retained.handle);
let pluginCalls = 0;
const plugin = new contexts[1].Bitmap(32, 32);
plugin._drawTextBody = function() { pluginCalls++; };
plugin.drawText('plugin', 0, 0, 20, 24, 'center');
assert.equal(pluginCalls, 1);
plugin._canvas._releaseNativeCanvas();
const canvasPlugin = new contexts[1].Bitmap(32, 32);
const fillText = canvasPlugin._context.fillText;
canvasPlugin._context.fillText = function() { pluginCalls++; return fillText.apply(this, arguments); };
canvasPlugin.drawText('Canvas plugin', 0, 0, 20, 24, 'center');
assert.equal(pluginCalls, 2);
canvasPlugin._canvas._releaseNativeCanvas();
const invalidPaint = new contexts[1].Bitmap(32, 32);
invalidPaint.textColor = 0xff0000; invalidPaint._context.fillStyle = 'blue';
invalidPaint.drawText('X', 0, 0, 24, 24, 'left');
assert.equal(invalidPaint._context.fillStyle, '#0000ff');
assert.ok(pixels(invalidPaint).every((value, i) => i % 4 !== 0 || value === 0));
invalidPaint._canvas._releaseNativeCanvas();
assert.equal(native.canvas.memory().liveCount, 0);
console.log(JSON.stringify({ comparisons, liveCount: native.canvas.memory().liveCount }));
