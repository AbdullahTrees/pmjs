'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');
const native = require(path.resolve(process.argv[2]));
const width = 32, height = 24;
native.initialize({ gameRoot: path.resolve(process.argv[3]), width, height,
  windowTitle: 'Pixi 4 anchored tiling' });
native.render.setClearColor(0, 0, 0, 0);
const canvases = [];
const images = [];
try {
  const { sandbox, makeTexture } = makeHarness();
  sandbox.nativeScenePacketVersion = native.scene.schema.version;
  sandbox.NativeHost.scene.submit = native.scene.submit;
  sandbox.NativeHost.scene.schema.atlasTilingSampling = native.scene.schema.atlasTilingSampling;
  class PictureTilingSprite extends sandbox.PIXI.extras.TilingSprite {}
  sandbox.PIXI.extras.PictureTilingSprite = PictureTilingSprite;
  const canvas = native.canvas.create(width, height);
  canvases.push(canvas);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels.set([x * 7, y * 9, (x < width / 2 ? 32 : 160) + (y < height / 2 ? 0 : 64), 255],
      (y * width + x) * 4);
  }
  native.canvas.writePixels(canvas.handle, 0, 0, width, height, pixels);
  const texture = makeTexture(width, height);
  texture.baseTexture.source._nativeImage.handle = canvas.handle;
  for (const nearest of [true, false]) for (const picture of [true, false]) {
    for (const respectAnchor of [false, true]) {
      texture.baseTexture.scaleMode = nearest ? sandbox.PIXI.SCALE_MODES.NEAREST : sandbox.PIXI.SCALE_MODES.LINEAR;
      const stage = new sandbox.PIXI.Container();
      const SpriteType = picture ? PictureTilingSprite : sandbox.PIXI.extras.TilingSprite;
      const node = new SpriteType(texture, width, height);
      node.anchor = { x: 0.5, y: 0.5 };
      node.origin = { x: -width / 2, y: -height / 2 };
      node.x = width / 2; node.y = height / 2;
      node.uvRespectAnchor = respectAnchor;
      stage.addChild(node);
      native.beginFrame();
      assert.equal(sandbox.submitNativeScene(stage), true);
      native.renderFrame(); native.swapFrame();
      const actual = native.canvas.captureSceneRawPremultiplied();
      const expected = new Uint8Array(pixels.length);
      const shift = picture || respectAnchor ? 0 : 1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const source = (((y + shift * height / 2) % height) * width +
          (x + shift * width / 2) % width) * 4;
        expected.set(pixels.subarray(source, source + 4), (y * width + x) * 4);
      }
      assert.deepEqual(Buffer.from(actual), Buffer.from(expected),
        `picture=${picture} respectAnchor=${respectAnchor} nearest=${nearest}`);
      assert.equal(node.uvRespectAnchor, respectAnchor);
      assert.deepEqual(node.origin, { x: -width / 2, y: -height / 2 });
    }
  }
  const childCanvas = native.canvas.create(2, 2);
  canvases.push(childCanvas);
  const childPixels = new Uint8Array(16);
  for (let i = 0; i < childPixels.length; i += 4) childPixels.set([255, 0, 0, 255], i);
  native.canvas.writePixels(childCanvas.handle, 0, 0, 2, 2, childPixels);
  const childTexture = makeTexture(2, 2);
  childTexture.baseTexture.source._nativeImage.handle = childCanvas.handle;
  function capture(stage, renderer) {
    native.beginFrame();
    if (renderer) sandbox.renderNativeStage(stage, undefined, 1, false, false, null, { renderer });
    else assert.equal(sandbox.submitNativeScene(stage), true);
    native.renderFrame(); native.swapFrame();
    return Buffer.from(native.canvas.captureSceneRawPremultiplied());
  }
  for (const resolution of [1, 2]) for (const nearest of [true, false]) {
    for (const picture of [true, false]) {
      const tileTexture = makeTexture(width / resolution, height / resolution);
      tileTexture.baseTexture.resolution = resolution;
      tileTexture.baseTexture.source._nativeImage.handle = canvas.handle;
      tileTexture.baseTexture.scaleMode = nearest ? sandbox.PIXI.SCALE_MODES.NEAREST : sandbox.PIXI.SCALE_MODES.LINEAR;
      const stage = new sandbox.PIXI.Container();
      const SpriteType = picture ? PictureTilingSprite : sandbox.PIXI.extras.TilingSprite;
      const node = new SpriteType(tileTexture, width, height);
      node.anchor = { x: 0.25, y: 0.5 };
      node.x = width / 4; node.y = height / 2;
      node.tilePosition = { x: 1.25, y: -2.5 };
      node.tileTransform.pivot = { x: 1.5, y: 2 };
      node.uvRespectAnchor = true;
      const child = new sandbox.PIXI.Sprite(childTexture);
      child.x = 3; child.y = 4; node.addChild(child);
      stage.addChild(node);
      const normal = capture(stage);
      for (const [scaleX, scaleY] of [[0, 1], [1, 0], [0, 0], [-0, 1]]) {
        node.tileScale = { x: scaleX, y: scaleY };
        const expected = new Uint8Array(pixels.length);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const insideChild = x >= node.x + child.x && x < node.x + child.x + 2 &&
            y >= node.y + child.y && y < node.y + child.y + 2;
          expected.set(insideChild ? [255, 0, 0, 255] : pixels.subarray(0, 4),
            (y * width + x) * 4);
        }
        assert.deepEqual(capture(stage), Buffer.from(expected),
          `zero tile scale=${scaleX},${scaleY} picture=${picture} nearest=${nearest} resolution=${resolution}`);
        assert.ok(Object.is(node.tileScale.x, scaleX));
        assert.equal(node.tileScale.y, scaleY);
      }
      node.tileScale = { x: 1, y: 1 };
      assert.deepEqual(capture(stage), normal, 'restoring tile scale restores the retained texture and children');
    }
  }
  function makePatternTexture(textureWidth, textureHeight, translucent = true) {
    const canvas = native.canvas.create(textureWidth, textureHeight);
    canvases.push(canvas);
    const pixels = new Uint8Array(textureWidth * textureHeight * 4);
    for (let y = 0; y < textureHeight; y++) for (let x = 0; x < textureWidth; x++) {
      for (let channel = 0; channel < 4; channel++) {
        pixels[(y * textureWidth + x) * 4 + channel] = channel === 3 ?
          (translucent ? 64 + (x + y) % 4 * 48 : 255) : (x * 47 + y * 29 + channel * 61) % 256;
      }
    }
    native.canvas.writePixels(canvas.handle, 0, 0, textureWidth, textureHeight, pixels);
    const texture = makeTexture(textureWidth, textureHeight);
    texture.baseTexture.source._nativeImage.handle = canvas.handle;
    return texture;
  }
  native.render.setClearColor(0, 0, 0, 1);
  native.render.configurePixiFragmentPrecision('mediump');
  sandbox.PIXI.WRAP_MODES = { CLAMP: 0, REPEAT: 1 };
  for (const picture of [false, true]) for (const prebound of [false, true]) {
    const wrapTexture = makePatternTexture(4, 4, false);
    wrapTexture.baseTexture.scaleMode = sandbox.PIXI.SCALE_MODES.LINEAR;
    wrapTexture.baseTexture.wrapMode = sandbox.PIXI.WRAP_MODES.CLAMP;
    wrapTexture.baseTexture._glTextures = {};
    const renderer = { CONTEXT_UID: 123, bindTexture(texture) {
      const base = texture.baseTexture || texture;
      base._glTextures[this.CONTEXT_UID] = {};
    } };
    if (prebound) renderer.bindTexture(wrapTexture);
    // An upload in another renderer must not prevent cold repeat selection.
    else wrapTexture.baseTexture._glTextures[456] = {};
    const Type = picture ? PictureTilingSprite : sandbox.PIXI.extras.TilingSprite;
    const node = new Type(wrapTexture, 20, 16);
    node.x = 8; node.y = 6;
    node.tilePosition = { x: 0.25, y: -0.125 };
    node.tileScale = { x: 1.5, y: 2 };
    const stage = new sandbox.PIXI.Container(); stage.addChild(node);
    const actual = capture(stage, renderer);
    const offset = (6 * width + 8) * 4;
    assert.deepEqual(Array.from(actual.subarray(offset, offset + 4)),
      prebound ? [0, 61, 122, 255] : [63, 108, 100, 255],
      `POT linear upload state, prebound=${prebound}, picture=${picture}`);
    assert.equal(wrapTexture.baseTexture.wrapMode, prebound ? 0 : 1);
    assert.ok(wrapTexture.baseTexture._glTextures[123]);
    assert.equal(sandbox.nativeSceneRenderer, null, 'render context is restored after submission');
    assert.deepEqual(capture(stage, renderer), actual, 'warm rendering retains its first selected wrap mode');
  }
  const boundaryTexture = makePatternTexture(4, 4);
  boundaryTexture.baseTexture.scaleMode = sandbox.PIXI.SCALE_MODES.NEAREST;
  for (const picture of [false, true]) {
    const stage = new sandbox.PIXI.Container();
    const Type = picture ? PictureTilingSprite : sandbox.PIXI.extras.TilingSprite;
    const node = new Type(boundaryTexture, 20, 16);
    node.x = 8; node.y = 6;
    node.anchor = { x: 0.25, y: 0.5 };
    node.tilePosition = { x: 1.25, y: -2.5 };
    node.tileScale = { x: 2, y: 0.5 };
    node.tileTransform.pivot = { x: 1.5, y: 2 };
    node.uvRespectAnchor = true;
    stage.addChild(node);
    const actual = capture(stage);
    for (const [x, y, expected] of [
      [3, 0, [59, 97, 136, 255]], [6, 0, [71, 121, 170, 255]],
      [3, 2, [79, 106, 21, 255]], [6, 2, [71, 121, 170, 255]]
    ]) {
      assert.deepEqual(Array.from(actual.subarray((y * width + x) * 4, (y * width + x + 1) * 4)),
        expected, `nearest tiling texel boundary at ${x},${y}, picture=${picture}`);
    }
    node.tileScale = { x: 1, y: 1 };
    const normal = capture(stage);
    for (const [x, y, expected] of [
      [3, 0, [143, 21, 59, 255]], [4, 0, [71, 121, 170, 255]],
      [3, 1, [115, 165, 6, 255]], [6, 2, [59, 97, 136, 255]]
    ]) {
      assert.deepEqual(Array.from(normal.subarray((y * width + x) * 4, (y * width + x + 1) * 4)),
        expected, `nearest POT reuse boundary at ${x},${y}, picture=${picture}`);
    }
    node.tileScale = { x: -0, y: 1 };
    const collapsed = capture(stage);
    assert.deepEqual(Array.from(collapsed.subarray(3 * 4, 4 * 4)), [0, 15, 31, 255]);
    assert.ok(Object.is(node.tileScale.x, -0));
    assert.equal(node.texture, boundaryTexture);
    node.tileScale = { x: 1, y: 1 };
    assert.deepEqual(capture(stage), normal, 'restoring POT tile scale restores every pixel');
  }
  const npotTexture = makePatternTexture(3, 5);
  npotTexture.baseTexture.scaleMode = sandbox.PIXI.SCALE_MODES.LINEAR;
  for (const picture of [false, true]) {
    const stage = new sandbox.PIXI.Container();
    const Type = picture ? PictureTilingSprite : sandbox.PIXI.extras.TilingSprite;
    const node = new Type(npotTexture, 20, 16);
    node.x = 8; node.y = 6;
    node.anchor = { x: 0.25, y: 0.5 };
    node.tilePosition = { x: 1.25, y: -2.5 };
    node.tileTransform.pivot = { x: 1.5, y: 2 };
    node.uvRespectAnchor = true;
    stage.addChild(node);
    const normal = capture(stage);
    for (const [x, y, expected] of [
      [3, 1, [87, 76, 22, 255]], [4, 1, [132, 9, 48, 255]],
      [5, 1, [40, 58, 48, 255]], [3, 6, [87, 76, 22, 255]]
    ]) {
      assert.deepEqual(Array.from(normal.subarray((y * width + x) * 4, (y * width + x + 1) * 4)),
        expected, `linear NPOT repeat boundary at ${x},${y}, picture=${picture}`);
    }
    node.tileScale = { x: -0, y: 1 };
    const collapsed = capture(stage);
    assert.deepEqual(Array.from(collapsed.subarray((width + 3) * 4, (width + 4) * 4)), [0, 15, 31, 255]);
    node.tileScale = { x: 1, y: 1 };
    assert.deepEqual(capture(stage), normal, 'restoring NPOT tile scale restores every pixel');
  }
  const atlasTexture = makePatternTexture(8, 8);
  atlasTexture.frame = atlasTexture._frame = { x: 2, y: 2, width: 3, height: 3 };
  atlasTexture.orig = { x: 0, y: 0, width: 3, height: 3 };
  atlasTexture.width = atlasTexture.height = 3;
  atlasTexture.baseTexture.scaleMode = sandbox.PIXI.SCALE_MODES.NEAREST;
  for (const picture of [false, true]) {
    const stage = new sandbox.PIXI.Container();
    const Type = picture ? PictureTilingSprite : sandbox.PIXI.extras.TilingSprite;
    const node = new Type(atlasTexture, 20, 16);
    node.x = 8; node.y = 6;
    node.anchor = { x: 0.25, y: 0.5 };
    node.tilePosition = { x: 1.25, y: -2.5 };
    node.tileScale = { x: 2, y: 0.5 };
    node.tileTransform.pivot = { x: 1.5, y: 2 };
    node.uvRespectAnchor = true;
    stage.addChild(node);
    const normal = capture(stage);
    for (const [x, y, expected] of [
      [3, 0, [1, 51, 100, 255]], [6, 0, [79, 106, 21, 255]],
      [3, 2, [87, 2, 29, 255]], [6, 2, [38, 53, 5, 255]],
      [22, 13, [154, 32, 70, 255]], [3, 13, [143, 21, 59, 255]]
    ]) {
      assert.deepEqual(Array.from(normal.subarray((y * width + x) * 4, (y * width + x + 1) * 4)),
        expected, `nearest atlas boundary at ${x},${y}, picture=${picture}`);
    }
    assert.equal(atlasTexture.__pmjsTilingCanvas, undefined, 'atlas sampling retains the original source');
    node.tileScale = { x: -0, y: 1 };
    const collapsed = capture(stage);
    assert.deepEqual(Array.from(collapsed.subarray(3 * 4, 4 * 4)), [38, 53, 5, 255]);
    node.tileScale = { x: 2, y: 0.5 };
    assert.deepEqual(capture(stage), normal, 'restoring atlas tile scale restores every pixel');
  }
  atlasTexture.baseTexture.scaleMode = sandbox.PIXI.SCALE_MODES.LINEAR;
  const atlasStage = new sandbox.PIXI.Container();
  const atlasNode = atlasStage.addChild(new sandbox.PIXI.extras.TilingSprite(atlasTexture, 20, 16));
  atlasNode.x = 8; atlasNode.y = 6;
  atlasNode.anchor = { x: 0.25, y: 0.5 };
  atlasNode.uvRespectAnchor = true;
  atlasNode.tilePosition = { x: 1.25, y: -2.5 };
  atlasNode.tileTransform.pivot = { x: 1.5, y: 2 };
  const canvasAtlas = capture(atlasStage);
  for (const [x, y, expected] of [
    [3, 0, [58, 39, 80, 255]], [3, 2, [108, 21, 56, 255]],
    [22, 13, [154, 32, 70, 255]], [3, 13, [104, 10, 39, 255]]
  ]) {
    assert.deepEqual(Array.from(canvasAtlas.subarray((y * width + x) * 4, (y * width + x + 1) * 4)),
      expected, `linear atlas boundary at ${x},${y}`);
  }
  const originalHandle = atlasTexture.baseTexture.source._nativeImage.handle;
  const decoded = native.images.loadBytes(native.canvas.encodePng(originalHandle));
  images.push(decoded);
  atlasTexture.baseTexture.source._nativeImage.handle = decoded.handle;
  assert.deepEqual(capture(atlasStage), canvasAtlas,
    'linear atlas sampling premultiplies decoded pixels before interpolation');
  atlasTexture.baseTexture.source._nativeImage.handle = originalHandle;
  const batchStage = new sandbox.PIXI.Container();
  const separateFrames = [];
  for (const [index, frameX] of [2, 3].entries()) {
    const texture = { ...atlasTexture, frame: { x: frameX, y: 2, width: 3, height: 3 } };
    texture._frame = texture.frame;
    const node = new sandbox.PIXI.extras.TilingSprite(texture, 12, 8);
    node.x = index === 0 ? 6 : 22; node.y = 6;
    node.anchor = { x: 0.25, y: 0.5 };
    node.uvRespectAnchor = true;
    node.tileScale = { x: index + 1, y: 0.5 };
    const isolated = new sandbox.PIXI.Container();
    isolated.addChild(node);
    separateFrames.push(capture(isolated));
    batchStage.addChild(node);
  }
  const combined = capture(batchStage);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    assert.deepEqual(combined.subarray(offset, offset + 4),
      separateFrames[x < 16 ? 0 : 1].subarray(offset, offset + 4),
      'atlas draws sharing an image retain their separate UV transforms and frames');
  }
  const ordinary = new sandbox.PIXI.Sprite(boundaryTexture);
  const invalidStage = new sandbox.PIXI.Container();
  invalidStage.addChild(ordinary);
  const submit = sandbox.NativeHost.scene.submit;
  for (const flags of [1048576, 1048576 | 32768]) {
    sandbox.NativeHost.scene.submit = function(version, metadata, values, count) {
      metadata[7 + 5] |= flags;
      return submit(version, metadata, values, count);
    };
    native.beginFrame();
    assert.throws(() => sandbox.submitNativeScene(invalidStage), /scene packet|scene submission/);
  }
  const invalidTilingStage = new sandbox.PIXI.Container();
  invalidTilingStage.addChild(new sandbox.PIXI.extras.TilingSprite(atlasTexture, 20, 16));
  sandbox.NativeHost.scene.submit = function(version, metadata, values, count) {
    metadata[7 + 5] &= ~32768;
    return submit(version, metadata, values, count);
  };
  native.beginFrame();
  assert.throws(() => sandbox.submitNativeScene(invalidTilingStage), /scene packet|scene submission/);
  sandbox.NativeHost.scene.submit = submit;
  console.log('anchored and zero-scale tiling, retained textures, children and repeat boundaries match exactly');
} finally {
  for (const image of images) native.images.release(image.handle);
  for (const canvas of canvases) native.canvas.release(canvas.handle);
  native.runtime.quit();
}
