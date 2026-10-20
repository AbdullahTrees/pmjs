'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname,
  '../js/pmjs-mz/menu-background.js'), 'utf8');

function harness() {
  class Container {
    constructor() {
      Object.assign(this, { x: 0, y: 0, alpha: 1, rotation: 0,
        scale: { x: 1, y: 1 }, pivot: { x: 0, y: 0 }, skew: { x: 0, y: 0 },
        visible: true, renderable: true, children: [], parent: null });
    }
    addChild(child) { child.parent = this; this.children.push(child); return child; }
  }
  class Sprite extends Container {
    constructor() {
      super();
      Object.assign(this, { anchor: { x: 0, y: 0 }, tint: 0xffffff, blendMode: 0 });
    }
    render() {}
    _render() {}
    renderAdvanced() {}
    calculateVertices() {}
  }
  class Scene_MenuBase extends Container {}
  class Scene_Battle extends Container {}
  class Spriteset_Battle extends Sprite {}
  class BlurPass { apply() {} }
  const program = {};
  class BlurFilter {
    constructor() {
      Object.assign(this, { blur: 8, blurX: 8, blurY: 8, quality: 4,
        padding: 16, resolution: 1, enabled: true, blendMode: 0,
        repeatEdgePixels: false });
      this.blurXFilter = new BlurPass(); this.blurYFilter = new BlurPass();
      for (const pass of [this.blurXFilter, this.blurYFilter]) {
        pass.program = program; pass.quality = 4;
      }
    }
    apply() {}
  }

  const preparations = [], releases = [], images = [], captures = [], warnings = [];
  const enabled = new Map(), names = [];
  let allocationFailure = null;
  let nextHandle = 900;
  const targetSizes = [];
  const context = {
    Sprite, Scene_MenuBase, Scene_Battle, Spriteset_Battle,
    PIXI: { filters: { BlurFilter }, BLEND_MODES: { NORMAL: 0 }, WRAP_MODES: { CLAMP: 33071 } },
    PMJS: {
      optimizations: {
        register(definition) { assert.ok(!enabled.has(definition.id));
          enabled.set(definition.id, true); names.push(definition.id); },
        isEnabled(id) { return enabled.get(id); },
        reportFallback(id, reason) { warnings.push({ id, reason }); }
      },
      pixi5: { registerRenderPreparation(fn, cleanup) {
        preparations.push(fn); releases.push(cleanup);
      } }
    },
    NativeHost: { render: {
      setRenderTargetSize(w, h) { targetSizes.push(['target', w, h]); },
      setScreenRenderSize(w, h) { targetSizes.push(['screen', w, h]); },
      renderToImage(w, h, options) {
        if (allocationFailure) throw allocationFailure;
        const image = { handle: nextHandle++ };
        images.push({ image, w, h, options }); return image;
      }
    } },
    trackNativeResource(image) { return image; },
    releaseNativeResource(image, kind) { assert.equal(kind, 'image'); released.push(image.handle); },
    pmjsPixi5RenderScene(sprite) { captures.push(sprite); }
  };
  const released = [];
  vm.runInNewContext(source, context, { filename: 'menu-background.js' });
  assert.deepEqual(names, ['mz.menu-background-cache', 'mz.battle-background-cache']);

  const renderer = { width: 64, height: 64, resolution: 1, roundPixels: false,
    screen: { width: 64, height: 64 } };
  function background() {
    const sprite = new Sprite();
    const base = { resolution: 1, wrapMode: 33071, scaleMode: 0, _updateID: 1,
      resource: { source: { __pmjsContentRevision: 1 } } };
    sprite.texture = { baseTexture: base, _updateID: 1, frame: { x: 0, y: 0, width: 64, height: 64 },
      orig: { width: 64, height: 64 } };
    sprite.filters = [new BlurFilter()];
    sprite.bitmap = { width: 64, height: 64, isReady() { return true; } };
    return sprite;
  }
  function menu() {
    const scene = new Scene_MenuBase();
    scene._backgroundSprite = background();
    scene.addChild(scene._backgroundSprite);
    return scene;
  }
  function battle() {
    const scene = new Scene_Battle();
    const spriteset = scene._spriteset = new Spriteset_Battle();
    spriteset._baseSprite = new Sprite();
    spriteset._backgroundSprite = background();
    scene.addChild(spriteset);
    spriteset.addChild(spriteset._baseSprite);
    spriteset._baseSprite.addChild(spriteset._backgroundSprite);
    // Stock MZ retains two live color filters on ancestors of the snapshot.
    spriteset.filters = [{ name: 'overallColor' }];
    spriteset._baseSprite.filters = [{ name: 'tone' }];
    return scene;
  }
  function prepare(scene, offscreen = false) {
    const prepared = new WeakMap();
    preparations[0](renderer, scene, offscreen, prepared);
    const sprite = scene._backgroundSprite || scene._spriteset && scene._spriteset._backgroundSprite;
    return sprite && prepared.get(sprite);
  }
  return { context, renderer, menu, battle, prepare, images, captures, released,
    targetSizes, warnings, enabled, releases,
    fail(error) { allocationFailure = error; } };
}

test('stock battle snapshot is captured once and reused with live ancestor filters', () => {
  const f = harness(), scene = f.battle(), sprite = scene._spriteset._backgroundSprite;
  const filters = sprite.filters, bitmap = sprite.bitmap;
  const first = f.prepare(scene);
  assert.equal(first.resource, 900);
  assert.equal(first.width, 64); assert.equal(first.height, 64);
  assert.equal(f.images[0].options.alphaMode, 'premultiplied');
  assert.equal(f.captures[0], sprite);
  assert.equal(f.prepare(scene).resource, 900);
  assert.equal(f.images.length, 1);
  // Changes outside the cached leaf remain dynamic, including game-visible tones.
  scene._spriteset.filters[0].name = 'changed overall';
  scene._spriteset._baseSprite.filters[0].name = 'changed tone';
  scene._spriteset._baseSprite.addChild(new f.context.Sprite());
  assert.equal(f.prepare(scene).resource, 900);
  assert.equal(sprite.filters, filters); assert.equal(sprite.bitmap, bitmap);
  assert.deepEqual(f.released, []);
});

test('battle cache invalidates changes to source, texture, blur, opacity and bitmap', () => {
  const f = harness(), scene = f.battle(), sprite = scene._spriteset._backgroundSprite;
  f.prepare(scene);
  for (const mutate of [
    () => sprite.texture.baseTexture.resource.source.__pmjsContentRevision++,
    () => sprite.texture._updateID++,
    () => { sprite.alpha = 0.5; },
    () => { const blur = sprite.filters[0]; blur.blur = blur.blurX = blur.blurY = 4;
      blur.padding = 8; },
    () => { sprite.bitmap = { ...sprite.bitmap }; },
    () => { f.renderer.roundPixels = true; },
    () => { sprite.roundPixels = true; },
    () => { sprite.filters[0].blurXFilter.quality = 3; },
  ]) {
    const before = f.images.length;
    mutate();
    assert.equal(f.prepare(scene).resource, 900 + before);
    assert.equal(f.prepare(scene).resource, 900 + before);
    assert.equal(f.images.length, before + 1);
    assert.equal(f.released.length, before);
  }
  assert.deepEqual(f.warnings, []);
});

test('menu and battle have independent enable switches and release cache on transitions', () => {
  const f = harness(), menu = f.menu(), battle = f.battle();
  f.prepare(menu); assert.equal(f.images.length, 1);
  f.prepare(battle); assert.equal(f.images.length, 2);
  assert.deepEqual(f.released, [900]);
  f.enabled.set('mz.battle-background-cache', false);
  assert.equal(f.prepare(battle), undefined);
  assert.deepEqual(f.released, [900, 901]);
  assert.equal(f.prepare(menu).resource, 902);
  f.enabled.set('mz.menu-background-cache', false);
  assert.equal(f.prepare(menu), undefined);
  assert.deepEqual(f.released, [900, 901, 902]);
});

test('unsupported battle sprite geometry, ancestry, filters and state use stock rendering', () => {
  for (const mutate of [
    scene => { scene._spriteset.x = 2; },
    scene => { scene._spriteset._baseSprite.alpha = 0.9; },
    scene => { scene._spriteset._backgroundSprite.addChild(new scene._spriteset.constructor()); },
    scene => { scene._spriteset._backgroundSprite.filters[0].quality = 16; },
    scene => { scene._spriteset._backgroundSprite.render = function() {}; },
    scene => { scene._spriteset._backgroundSprite.texture.baseTexture.resource.source.__pmjsContentRevision = undefined; },
    scene => { scene._spriteset._backgroundSprite.parent = null; },
  ]) {
    const f = harness(), scene = f.battle();
    assert.equal(f.prepare(scene).resource, 900);
    mutate(scene);
    assert.equal(f.prepare(scene), undefined);
    assert.deepEqual(f.released, [900]);
  }
});

test('hidden, offscreen, absent and removed battle snapshots do not retain stale images', () => {
  const f = harness(), scene = f.battle(), sprite = scene._spriteset._backgroundSprite;
  sprite.visible = false;
  assert.equal(f.prepare(scene), undefined);
  sprite.visible = true;
  assert.equal(f.prepare(scene).resource, 900);
  assert.equal(f.prepare(scene, true), undefined, 'offscreen renders the unmodified filter path');
  assert.equal(f.prepare(scene).resource, 900, 'offscreen preparation does not invalidate a warm cache');
  sprite.visible = false;
  assert.equal(f.prepare(scene), undefined);
  assert.deepEqual(f.released, [900]);
  sprite.visible = true;
  assert.equal(f.prepare(scene).resource, 901);
  const other = new f.context.Scene_Battle();
  assert.equal(f.prepare(other), undefined);
  assert.deepEqual(f.released, [900, 901]);
});

test('allocation failure uses original render path, restores target and does not leak', () => {
  const f = harness(), scene = f.battle();
  f.prepare(scene);
  scene._spriteset._backgroundSprite.texture._updateID++;
  const error = Object.assign(new Error('out of texture memory'),
    { code: 'PMJS_RENDER_IMAGE_ALLOCATION' });
  f.fail(error);
  assert.equal(f.prepare(scene), undefined);
  assert.deepEqual(f.released, [900]);
  assert.equal(f.targetSizes.at(-1)[0], 'screen');
  assert.ok(f.warnings.some(x => x.id === 'mz.battle-background-cache' &&
    x.reason === 'battle background image allocation failed'));
  f.fail(null);
  assert.equal(f.prepare(scene).resource, 901);
  f.releases[0](f.renderer);
  assert.deepEqual(f.released, [900, 901]);
});

test('unrelated capture errors remain visible and render target size is restored', () => {
  const f = harness(), scene = f.battle(), error = new Error('unexpected');
  f.fail(error);
  assert.throws(() => f.prepare(scene), e => e === error);
  assert.equal(f.targetSizes.at(-1)[0], 'screen');
  assert.deepEqual(f.images, []);
});
