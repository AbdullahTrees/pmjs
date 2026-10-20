'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContext, runModule } = require('./helpers/pixi5-context.cjs');
const { png } = require('./helpers/png.cjs');
const native = require(path.resolve(process.argv[2]));
const assets = path.resolve(process.argv[3]);
const root = fs.mkdtempSync(path.join(assets, 'pmjs-scenery-window-'));
const source = 'img/overlays/scenery.png';
const sourceFile = path.join(root, source);
const tileDirectory = path.join(root, 'prepared-scenery');
const tileSetId = 'scenery-window-test';
let image = null;
let initialized = false;

async function main() {
  try {
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, png(2049, 2049, Buffer.alloc(2049 * 2049 * 4, 255)));
    native.initialize({ gameRoot: root, width: 32, height: 24,
      windowTitle: 'prepared scenery windows' });
    initialized = true;
    fs.mkdirSync(tileDirectory, { recursive: true });

    const rectangles = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      rectangles.push([x * 683, y * 683, 683, 683]);
    }
    const descriptor = await native.assets.processTiles([
      { file: sourceFile, rectangles },
    ], tileDirectory);
    Object.assign(descriptor.sources[0], {
      source,
      snapshot: sourceFile,
      sourceIdentity: native.assets.sourceIdentity(source),
    });
    const tileSet = { identity: tileSetId, directory: tileDirectory, descriptor };
    assert.equal(native.assets.installTileSets([tileSet], true), 1);
    image = await native.images.loadAsync(source, false, tileSetId);

    const { context } = createContext();
    context.NativeHost.render = native.render;
    context.NativeHost.scene.submit = native.scene.submit;
    Object.assign(context.NativeHost.scene.schema, native.scene.schema);
    context.PIXI.Texture = class {
      constructor(baseTexture, frame) { Object.assign(this, { baseTexture, frame, valid: true }); }
    };
    context.PIXI.filters = { AlphaFilter: class {} };
    runModule(context, 'js/pmjs-core/methods.js');
    runModule(context, 'js/pmjs-pixi5/scene.js');
    runModule(context, 'js/pmjs-pixi5/filters.js');
    runModule(context, 'js/pmjs-pixi5/renderer.js');
    context.PMJS.methods.install();

    const renderer = new context.PIXI.Renderer({ width: 32, height: 24, transparent: true });
    const baseTexture = { resource: { source: { _nativeImage: image } },
      width: 2049, height: 2049, resolution: 1,
      scaleMode: context.PIXI.SCALE_MODES.LINEAR };
    const texture = new context.PIXI.Texture(baseTexture,
      { x: 0, y: 0, width: 2049, height: 2049 });
    const stage = new context.PIXI.Container();
    const parallax = new context.PIXI.TilingSprite(texture, 32, 24);
    parallax.tilePosition.x = -1320;
    parallax.tilePosition.y = -624;
    stage.addChild(parallax);

    const before = native.images.memory();
    native.beginFrame();
    renderer.render(stage);
    native.renderScene();
    const after = native.images.memory();
    const owners = native.images.memory(100).largest;
    const window = owners.find(entry => entry.sceneryParent === image.handle);
    assert.ok(window, 'physical window is attributed to its logical image');
    assert.ok(window.path.endsWith(source));
    assert.equal(window.sceneryRect[2], window.width);
    assert.equal(window.sceneryRect[3], window.height);
    assert.equal(owners.find(entry => entry.handle === image.handle).fullTextureResident, false);
    assert.equal(after.sceneryWindowUploads, before.sceneryWindowUploads + 1,
      'prepared tile-backed parallax should upload one bounded scenery window');
    assert.equal(after.sceneryFullFallbacks, before.sceneryFullFallbacks,
      'prepared tile-backed parallax should not materialize its full texture');
    assert.ok(after.sceneryWindowReadMicros > before.sceneryWindowReadMicros,
      'scenery source reconstruction time is reported');
    assert.ok(after.sceneryWindowCreateMicros > before.sceneryWindowCreateMicros,
      'scenery texture creation and upload time is reported');
    assert.equal(after.preparedFallbacks['non-sprite'] || 0,
      before.preparedFallbacks['non-sprite'] || 0,
      'windowed tiling should avoid the generic non-sprite fallback');
    assert.ok(after.gpuBytes - before.gpuBytes < 10 * 1024 * 1024,
      'window upload should avoid allocating the full 2049x2049 parallax texture');
    assert.deepEqual(Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4)),
      [255, 255, 255, 255], 'prepared scenery window preserves the source pixels');

    parallax.tilePosition.x += 300;
    native.beginFrame();
    renderer.render(stage);
    native.renderScene();
    const moved = native.images.memory();
    assert.equal(moved.sceneryWindowUploads, after.sceneryWindowUploads,
      'a compatible window is reused while camera movement stays inside its coverage');
    assert.equal(moved.sceneryWindowHits, after.sceneryWindowHits + 1,
      'coverage reuse is counted as a scenery window hit');
    assert.equal(moved.sceneryWindowCreateMicros, after.sceneryWindowCreateMicros,
      'reusing a resident window performs no texture creation or upload');

    let scrolled = moved;
    for (let attempt = 0; attempt < 20 &&
        scrolled.sceneryWindowUploads === moved.sceneryWindowUploads; attempt++) {
      parallax.tilePosition.x += 50;
      native.beginFrame();
      renderer.render(stage);
      native.renderScene();
      scrolled = native.images.memory();
    }
    assert.equal(scrolled.sceneryWindowUploads, moved.sceneryWindowUploads + 1,
      'moving beyond resident coverage creates one replacement window');
    assert.equal(scrolled.sceneryScrollWindows, moved.sceneryScrollWindows + 1,
      'replacement window copies its overlap on the GPU and uploads exposed strips');
    assert.ok(scrolled.sceneryScrollCopyBytes > moved.sceneryScrollCopyBytes,
      'GPU overlap copy bytes are reported');
    assert.ok(scrolled.sceneryScrollUploadBytes > moved.sceneryScrollUploadBytes,
      'exposed strip upload bytes are reported');
    assert.ok(scrolled.sceneryScrollUploadBytes - moved.sceneryScrollUploadBytes <
      1536 * 1536 * 4, 'scroll replacement uploads less than a full window');
    assert.deepEqual(Array.from(native.canvas.captureSceneRawPremultiplied().subarray(0, 4)),
      [255, 255, 255, 255], 'GPU-overlap replacement preserves rendered pixels');
  } finally {
    if (image) native.images.release(image.handle);
    if (initialized) native.runtime.quit();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
