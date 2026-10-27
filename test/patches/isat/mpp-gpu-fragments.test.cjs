'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const test = require('node:test');

const { createGraphics } = require('./test-fixtures/native-graphics.cjs');
function setup(options = {}) {
  const { recognized = true, connected = true } = options;
  const graphics = createGraphics(options);
  const { context, hooks } = graphics;
  let source = `(function() {
    var MPPlugin = { LineWidth: 4, FlashOpacity: 200,
      TypeParams: { 3: { 'Shape Type': 1, 'Split X': 10, 'Split Y': 6 } } };
    function Fragment() {}
    Fragment.prototype.createBitmap = function() {};
    Fragment.prototype.initFrame = function() {};
    Fragment.prototype.setSnap = function() {};
    var NativePresenter = null;
    function Sprite_Fragment() {}
    Sprite_Fragment.FlashRate = 8;
    function Sprite_GpuFragments() { this.authored = true; }
    function EncounterEffect() {}
    EncounterEffect.Zoom = 2;
    EncounterEffect.NeedClip = true;
    EncounterEffect.clear = function() {};
    EncounterEffect.sortFragment = function(compare) { return this._data.sort(compare); };
    globalThis.fixtureOriginalSort = EncounterEffect.sortFragment;
    EncounterEffect.fragments = function() { return this._data; };
    globalThis.Scene_Base = function() { Sprite.call(this); };
    Scene_Base.prototype = Object.create(Sprite.prototype);
    Scene_Base.prototype.createEncEffSprites = function() {
      this._encEffContainer = new PIXI.Container();
      var presenter = new Sprite_GpuFragments(this.fragments);
      presenter.__isatMppGpuPresentation = true;
      this._encEffContainer.addChild(presenter);
      this.testSprite = presenter;
    };
    globalThis.Scene_Map = function() { Scene_Base.call(this); };
    Scene_Map.prototype = Object.create(Scene_Base.prototype);
    Scene_Map.prototype.launchBattle = function() {
      if (NativePresenter) return EncounterEffect.captureSnapshot(this.stage, this.type);
      return 'canvas';
    };
    globalThis.fixtureEffect = EncounterEffect;
  })();`;
  if (!recognized) source = source.replace('Fragment.prototype.setSnap', 'Fragment.prototype.otherSnap');
  if (connected) {
    source = source.replace('globalThis.fixtureEffect = EncounterEffect;',
      'NativePresenter = PMJS.installMppGpuFragments(EncounterEffect, MPPlugin, Sprite_Fragment.FlashRate, Fragment);' +
      'globalThis.fixtureEffect = EncounterEffect;');
  }
  vm.runInContext(source, context);
  hooks.forEach(callback => callback());
  context.PMJS.optimizations.finalize();
  const scene = new context.Scene_Map();
  scene.type = 3;
  scene.stage = { worldTransform: { identity() {} } };
  return { ...graphics, scene };
}

function fragment() {
  return {
    _frame: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 0, y: 60 }],
    _isatGpuSnap: { baseTexture: { scaleMode: 0 } }, _isatGpuColor: [255, 0, 0], _isatSnapX: 0, _isatSnapY: 0,
    x: 40, y: 30, jumpHeight: 0, visible: false, flashColor: null,
    rect() { return { x: 0, y: 0, width: 80, height: 60 }; },
    anchorX() { return 0.5; }, anchorY() { return 0.5; },
    scaleX() { return 2; }, scaleY() { return 2; }, rotation() { return 0; }
  };
}

test('native integration installs GPU capture and preserves clipping for later battles', () => {
  const { context, scene } = setup();
  assert.equal(context.PMJS.optimizations.isEnabled('plugins.mpp.gpu-fragments'), true);
  assert.equal(typeof scene.launchBattle().destroy, 'function');
  assert.equal(context.capture.resolution, 1);
  assert.deepEqual([context.capture.region.width, context.capture.region.height], [80, 60]);
  assert.equal(context.ISAT_CFG, undefined);
  scene.type = 2;
  assert.equal(scene.launchBattle(), 'canvas');
  assert.equal(context.fixtureEffect.NeedClip, true);
});

test('GPU eligibility checks neither access legacy configuration nor change clipping', () => {
  const { context } = setup();
  Object.defineProperty(context, 'ISAT_CFG', { get() { throw Error('unexpected configuration access'); } });
  let clipping = true;
  Object.defineProperty(context.fixtureEffect, 'NeedClip', {
    get() { return clipping; },
    set() { throw Error('eligibility changed clipping'); }
  });
  assert.equal(context.fixtureEffect.gpuFragmentsFor(3), true);
  assert.equal(context.fixtureEffect.gpuFragmentsFor(2), false);
  assert.equal(clipping, true);
});

test('capture failure preserves the Canvas path and releases a snapshot if reset fails', () => {
  const { context, scene } = setup();
  context.failCapture = true;
  assert.equal(scene.launchBattle(), 'canvas');
  assert.equal(context.fixtureEffect.NeedClip, true);
  context.failCapture = false;
  scene.stage.worldTransform.identity = () => { throw new Error('reset failed'); };
  assert.equal(scene.launchBattle(), 'canvas');
  assert.equal(context.released, true);
});

test('integration installs before renderer creation and waits for GPU capture capability', () => {
  const { context, scene, renderer } = setup({ rendererReady: false });
  assert.equal(context.PMJS.optimizations.isEnabled('plugins.mpp.gpu-fragments'), true);
  assert.equal(scene.launchBattle(), 'canvas');
  context.Graphics._renderer = renderer;
  assert.equal(typeof scene.launchBattle().destroy, 'function');
});

for (const via of ['config', 'env']) {
  test(`GPU effect disable through ${via} preserves the authored presenter`, () => {
    const { context, scene, retained } = setup({ disables: ['plugins.mpp.gpu-fragments'], via });
    assert.equal(scene.launchBattle(), 'canvas');
    scene.createEncEffSprites();
    assert.equal(scene.testSprite.authored, true);
    assert.equal(retained.length, 0);
    assert.equal(context.fixtureEffect.sortFragment, context.fixtureOriginalSort);
    assert.match(context.PMJS.optimizations.reason('plugins.mpp.gpu-fragments'), /disabled by/);
  });
}

test('ordinary encounters keep authored sorting and GPU encounters restore the array sort property', () => {
  const h = setup(), effect = h.context.fixtureEffect;
  effect._data = [3, 1, 2];
  effect._isatGpuActive = false;
  assert.deepEqual(Array.from(effect.sortFragment((a, b) => a - b)), [1, 2, 3]);
  assert.equal(h.sorts(), 0);
  effect._data = [3, 1, 2]; effect._isatGpuActive = true;
  effect.sortFragment((a, b) => a - b);
  assert.deepEqual(effect._data, [1, 2, 3]);
  assert.equal(h.sorts(), 1);
  assert.equal(Object.hasOwn(effect._data, 'sort'), false);
});

for (const options of [{ recognized: false }, { connected: false }]) {
  test(`missing plugin integration is reported as refused: ${JSON.stringify(options)}`, () => {
    const { context } = setup(options);
    assert.equal(context.PMJS.optimizations.isEnabled('plugins.mpp.gpu-fragments'), false);
    assert.match(context.PMJS.optimizations.reason('plugins.mpp.gpu-fragments'),
      options.recognized === false ? /composition is unavailable/ : /not installed/);
  });
}

test('presenter retains bitmap Sprites and clears each background triangle once', () => {
  const { context, scene, retained, invalidated, cleared } = setup();
  const piece = fragment();
  context.fixtureEffect._data = [piece];
  context.fixtureEffect._isatGpuActive = true;
  scene.createEncEffSprites();
  const item = scene.testSprite._items[0];
  assert.equal(retained.length, 1);
  assert.equal(retained[0].strokeSamples, 4);
  assert.ok(item.image instanceof context.Sprite);
  assert.deepEqual([item.image.texture.frame.width, item.image.texture.frame.height], [42, 32]);
  assert.deepEqual([item.image.anchor.x, item.image.anchor.y], [0.5, 0.5]);
  piece.visible = true;
  piece.x = 90;
  piece.flashColor = [255, 0, 0];
  piece.flashColor.clone = function() { return this.slice(); };
  scene.testSprite.update();
  assert.equal(item.image.x, 90);
  assert.ok(item.image instanceof context.Sprite);
  assert.deepEqual([item.image.texture.frame.width, item.image.texture.frame.height], [42, 32]);
  assert.deepEqual([item.image.anchor.x, item.image.anchor.y], [0.5, 0.5]);
  assert.deepEqual(invalidated, []);
  assert.equal(scene.testSprite._background.visible, false);
  assert.deepEqual(cleared[0].points, [0, 0, 80, 0, 0, 60]);
  assert.equal(item.image._blendColor[3], 0);
  assert.equal(context.capture.stage._blendColor[3], 192);
  assert.notEqual(item.image.texture, item.texture);
  const firstFlash = item.image.texture;
  for (let tick = 0; tick < 7; tick++) scene.testSprite.update();
  assert.equal(item.image.texture, firstFlash, 'retain the flash between authored refreshes');
  scene.testSprite.update();
  assert.equal(context.capture.stage._blendColor[3], 128);
  assert.notEqual(item.image.texture, firstFlash);
  for (let tick = 0; tick < 17; tick++) scene.testSprite.update();
  assert.equal(item.image._blendColor[3], 0);
  assert.equal(item.image.texture, item.texture);
  assert.equal(context.__isatMppGpuFragmentStats.flashAtlasBuilds, 3);
  assert.equal(invalidated.length, 0);
  assert.equal(cleared.length, 1);
});

test('stroke construction preserves authored coordinates away from the origin', () => {
  const { context, scene, retained } = setup();
  context.fixtureEffect.Zoom = 1;
  const piece = fragment();
  piece._frame = [{ x: 78, y: 296 }, { x: 141, y: 220 }, { x: 116, y: 321 }];
  piece.rect = () => ({ x: 78, y: 220, width: 63, height: 101 });
  context.fixtureEffect._data = [piece]; context.fixtureEffect._isatGpuActive = true;
  scene.createEncEffSprites();
  assert.deepEqual(Array.from(retained[0].paint.slice(0, 10)),
    [78, 296, 141, 220, 116, 321, 77, 219, 142, 322]);
  const image = scene.testSprite._items[0].image;
  assert.deepEqual([image.texture.frame.width, image.texture.frame.height], [65, 103]);
  assert.deepEqual([image.anchor.x, image.anchor.y], [0.5, 0.5]);
});

test('acute fragment paint stays finite and inside the authored Bitmap bounds', () => {
  const { context, scene } = setup();
  const piece = fragment();
  piece._frame = [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 0.25, y: 1 }];
  piece.rect = () => ({ x: 0, y: 0, width: 80, height: 1 });
  context.fixtureEffect._data = [piece]; context.fixtureEffect._isatGpuActive = true;
  scene.createEncEffSprites();
  const item = scene.testSprite._items[0];
  assert.ok(item.image instanceof context.Sprite);
  assert.deepEqual([item.image.texture.frame.width, item.image.texture.frame.height], [42, 3]);
});


test('battle handoff transfers retained Sprites and resets authored Sprite flash state', () => {
  const { context, scene, retained, released } = setup();
  const piece = fragment(); piece.visible = true;
  const fragments = [piece];
  context.fixtureEffect._data = fragments; context.fixtureEffect._isatGpuActive = true;
  scene.createEncEffSprites();
  const presenter = scene.testSprite, oldContainer = scene._encEffContainer;
  piece.flashColor = [255, 0, 0];
  piece.flashColor.clone = function() { return this.slice(); };
  presenter.update();
  assert.ok(presenter._items[0].flashDuration > 0);
  assert.notEqual(presenter._items[0].image.texture, presenter._items[0].texture);
  const flashAtlases = [...presenter._flashAtlases.values()].map(entry => entry.texture);
  scene.createEncEffSprites();
  assert.equal(scene.testSprite, presenter);
  assert.equal(presenter.parent, scene._encEffContainer);
  assert.ok(!oldContainer.children.includes(presenter));
  assert.equal(retained.length, 1);
  assert.equal(retained[0].strokeSamples, 4);
  assert.equal(presenter._items[0].image._blendColor[3], 0);
  assert.equal(presenter._items[0].flashDuration, 0);
  assert.equal(presenter._items[0].image.texture, presenter._items[0].texture);
  const atlas = presenter._atlas;
  context.fixtureEffect.clear();
  assert.ok(released.includes(presenter));
  assert.equal(presenter._atlas, null);
  assert.equal(presenter._flashAtlases.size, 0);
  assert.ok(flashAtlases.every(texture => texture.destroys === 1));
  assert.ok(atlas);
  context.fixtureEffect._data = [fragment()];
  context.fixtureEffect._isatGpuActive = true;
  scene.createEncEffSprites();
  assert.notEqual(scene.testSprite, presenter);
  assert.equal(retained.length, 2);
});


test('atlas Sprites inherit the actual YEP transform hook without changing simulation', () => {
  for (const yepPosition of [false, true]) {
    const { context, scene } = setup({ yepPosition });
    const piece = fragment();
    piece.x = 90.75;
    piece.y = -28.25;
    piece.jumpHeight = 0.3;
    context.fixtureEffect._data = [piece];
    context.fixtureEffect._isatGpuActive = true;
    scene.createEncEffSprites();
    const item = scene.testSprite._items[0];
    assert.equal(item.image.x, 90.75);
    item.image.updateTransform();
    assert.equal(item.image.worldTransform.tx, yepPosition ? 90 : 90.75);
    assert.equal(item.image.y, -28.55);
    assert.equal(item.image.worldTransform.ty, yepPosition ? -29 : -28.55);
    assert.equal(piece.x, 90.75);
    assert.equal(piece.y, -28.25);
    assert.equal(item.image.rotation, piece.rotation());
    assert.equal(item.image.scale.x, piece.scaleX());
    assert.equal(item.image.scale.y, piece.scaleY());
  }
});


test('failed private background capture releases the already baked atlas', () => {
  const { context, scene, released } = setup();
  const capture = context.Graphics._renderer.generateTextureGpu;
  let calls = 0, destroyed = 0;
  context.Graphics._renderer.generateTextureGpu = function(...args) {
    if (++calls === 2) throw new Error('background copy failed');
    const texture = capture.apply(this, args);
    texture.destroy = () => destroyed++;
    return texture;
  };
  context.fixtureEffect._data = [fragment()];
  context.fixtureEffect._isatGpuActive = true;
  assert.throws(() => scene.createEncEffSprites(), /background copy failed/);
  assert.equal(destroyed, 1);
  assert.ok(released.length >= 3);
});

test('native tint refusal and unknown transform hooks retain the Canvas presenter', () => {
  const disabled = setup({ disables: ['sprite.native-tint'] });
  assert.equal(disabled.scene.launchBattle(), 'canvas');
  const unknown = setup();
  unknown.context.Yanfly = undefined;
  unknown.context.Sprite.prototype.updateTransform = function() {};
  assert.equal(unknown.scene.launchBattle(), 'canvas');
});


test('encounter owns only worldState while preserving later HUD and segment policies', () => {
  for (const priorState of ['local', 'native', 'pixi']) {
    const { context, scene } = setup();
    const pixi = context.PMJS.pixi4;
    context.fixtureEffect._data = [fragment()]; context.fixtureEffect._isatGpuActive = true;
    const previousProducer = { nodes: [{ old: true }], valid() { return true; } };
    pixi.setStageRenderOptions(scene, { worldState: priorState, plainSpriteSegments: false, bitmapCacheProducers: previousProducer });
    scene.createEncEffSprites();
    assert.equal(pixi.getStageRenderOptions(scene).worldState, 'pixi');
    assert.equal(pixi.getStageRenderOptions(scene).plainSpriteSegments, false);
    assert.equal(pixi.getStageRenderOptions(scene).bitmapCacheProducers, previousProducer);
    const hud = { nodes: [{ battleHud: true }], valid() { return true; } };
    pixi.setStageRenderOptions(scene, { ...pixi.getStageRenderOptions(scene), bitmapCacheProducers: hud, plainSpriteSegments: true });
    scene.createEncEffSprites();
    context.fixtureEffect.clear();
    const restored = pixi.getStageRenderOptions(scene);
    assert.equal(restored.worldState, priorState);
    assert.equal(restored.plainSpriteSegments, true);
    assert.equal(restored.bitmapCacheProducers, hud);
  }
});

test('encounter restores absent worldState without clearing later fields or foreign replacements', () => {
  for (const update of ['hud', 'clear', 'foreign-world-state', 'none']) {
    const { context, scene } = setup();
    const pixi = context.PMJS.pixi4;
    context.fixtureEffect._data = [fragment()]; context.fixtureEffect._isatGpuActive = true;
    scene.createEncEffSprites();
    const hud = { nodes: [{}], valid() { return true; } };
    if (update === 'hud') pixi.setStageRenderOptions(scene, { ...pixi.getStageRenderOptions(scene), bitmapCacheProducers: hud, plainSpriteSegments: false });
    if (update === 'clear') pixi.setStageRenderOptions(scene, null);
    const foreign = { worldState: 'local', plainSpriteSegments: false, bitmapCacheProducers: hud };
    if (update === 'foreign-world-state') pixi.setStageRenderOptions(scene, foreign);
    context.fixtureEffect.clear();
    const restored = pixi.getStageRenderOptions(scene);
    if (update === 'hud') {
      assert.equal(restored.worldState, 'native');
      assert.equal(restored.bitmapCacheProducers, hud);
      assert.equal(restored.plainSpriteSegments, false);
    } else if (update === 'foreign-world-state') assert.equal(restored, foreign);
    else assert.equal(restored, undefined);
  }
});


test('flash cache bounds storage and falls back to per-sprite color for extra colors', () => {
  const { context, scene } = setup();
  const piece = fragment(); piece.visible = true;
  context.fixtureEffect._data = [piece]; context.fixtureEffect._isatGpuActive = true;
  scene.createEncEffSprites();
  const presenter = scene.testSprite, item = presenter._items[0];
  for (let color = 0; color < 4; color++) assert.ok(presenter.flashRegion(item, [color, 0, 0, 192]));
  assert.equal(presenter._flashAtlases.size, 4);
  piece.flashColor = [4, 0, 0]; piece.flashColor.clone = function() { return this.slice(); };
  presenter.update();
  assert.equal(item.image.texture, item.texture);
  assert.deepEqual(Array.from(item.image._blendColor), [4, 0, 0, 192]);
  assert.equal(presenter._flashAtlases.size, 4);
});

test('flash capture failure restores sampling and retains the ordinary flash fallback', () => {
  const { context, scene } = setup();
  const piece = fragment(); piece.visible = true;
  context.fixtureEffect._data = [piece]; context.fixtureEffect._isatGpuActive = true;
  scene.createEncEffSprites();
  const presenter = scene.testSprite, item = presenter._items[0], scale = presenter._atlas.baseTexture.scaleMode;
  context.failCapture = true;
  piece.flashColor = [2, 3, 4]; piece.flashColor.clone = function() { return this.slice(); };
  presenter.update();
  assert.equal(presenter._atlas.baseTexture.scaleMode, scale);
  assert.equal(item.image.texture, item.texture);
  assert.deepEqual(Array.from(item.image._blendColor), [2, 3, 4, 192]);
  assert.equal(presenter._flashCacheDisabled, true);
  context.failCapture = false;
  for (let tick = 0; tick < 8; tick++) presenter.update();
  assert.equal(presenter._flashAtlases.size, 0, 'failed allocation is not retried during the effect');
});
