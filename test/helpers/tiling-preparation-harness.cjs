'use strict';
const { makeHarness } = require('./scene-encoder-harness.cjs');
const { elementSources } = require('./web-element-sources.cjs');
const { runModule } = require('./runtime-context.cjs');

function makeTilingPreparationHarness(native, useNative = true) {
  const transfers = { readBytes: 0, writeBytes: 0 };
  const canvas = Object.create(native.canvas);
  for (const name of ['readPixels', 'readPremultipliedPixels']) {
    canvas[name] = (...args) => {
      const pixels = native.canvas[name](...args);
      transfers.readBytes += pixels.byteLength;
      return pixels;
    };
  }
  for (const name of ['writePixels', 'writePremultipliedPixels']) {
    canvas[name] = (...args) => {
      transfers.writeBytes += args[5].byteLength;
      return native.canvas[name](...args);
    };
  }
  if (!useNative) canvas.copyTransformedPixels = undefined;
  const harness = makeHarness({ beforeWriter(sandbox) {
    sandbox.NativeHost.canvas = canvas;
    sandbox.PMJS.config = {};
    sandbox.pmjsGameConfig = {};
    sandbox.nativeWindowState = { focused: true, visible: true };
    for (const file of ['js/pmjs-web/events.js', 'js/pmjs-web/canvas.js', ...elementSources]) {
      runModule(sandbox, file);
    }
  } });
  return { ...harness, transfers };
}

module.exports = { makeTilingPreparationHarness };
