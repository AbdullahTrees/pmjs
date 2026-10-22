'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');

function filterBegins(packet) {
  return packet.metadata.filter((value, index) => index % 7 === 0 && value === 6).length;
}

for (const segmented of [false, true]) {
  test(`ordinary filters use live backing state with segments=${segmented}`, () => {
    const h = makeHarness(), c = h.sandbox;
    c.PMJS.optimizations.isEnabled = id => id !== 'scene.plain-sprite-segment' || segmented;
    const root = new c.PIXI.Container();
    for (let i = 0; i < 8; i++) root.addChild(h.sprite());
    c.submitNativeScene(root);
    assert.equal(filterBegins(h.submitted.at(-1)), 0, 'warm traversal sees the plain tree');
    const node = root.children[0];
    const filter = new c.PIXI.filters.BlurFilter(4, 2);
    let reads = 0;
    Object.defineProperty(node, 'filters', { configurable: true, get() { reads++; return [filter]; } });
    c.submitNativeScene(root);
    assert.equal(filterBegins(h.submitted.at(-1)), 0);
    node._filters = [filter];
    Object.defineProperty(node, 'filters', { configurable: true, get() { reads++; return null; } });
    c.submitNativeScene(root);
    assert.equal(filterBegins(h.submitted.at(-1)), 1);
    delete node.filters;
    node.filters = null;
    Object.defineProperty(c.PIXI.Sprite.prototype, 'filters', { get() { throw new Error('public getter'); } });
    c.submitNativeScene(root);
    assert.equal(filterBegins(h.submitted.at(-1)), 0);
    assert.equal(reads, 0);
  });

  test(`segmented traversal ignores public filter accessors on every child=${segmented}`, () => {
    const h = makeHarness(), c = h.sandbox, root = new c.PIXI.Container();
    c.PMJS.optimizations.isEnabled = id => id !== 'scene.plain-sprite-segment' || segmented;
    const reads = [];
    for (let i = 0; i < 8; i++) {
      const child = root.addChild(h.sprite());
      Object.defineProperty(child, 'filters', { get() { reads.push(i); return []; } });
    }
    c.submitNativeScene(root);
    assert.deepEqual(reads, []);
    assert.equal(h.submitted.length, 1);
  });
}

test('stock setter, enabled flags and backing array replacement stay live', () => {
  const h = makeHarness(), c = h.sandbox, node = h.sprite();
  const filter = new c.PIXI.filters.BlurFilter(4, 2);
  node.filters = [filter];
  c.submitNativeScene(node);
  assert.equal(filterBegins(h.submitted.at(-1)), 1);
  filter.enabled = false;
  c.submitNativeScene(node);
  assert.equal(filterBegins(h.submitted.at(-1)), 0);
  node._filters = [new c.PIXI.filters.BlurFilter(8, 2)];
  c.submitNativeScene(node);
  assert.equal(filterBegins(h.submitted.at(-1)), 1);
  node._filters.length = 0;
  c.submitNativeScene(node);
  assert.equal(filterBegins(h.submitted.at(-1)), 0);
});

test('enabled inspection observes filters appended to the backing array', () => {
  const h = makeHarness(), c = h.sandbox, node = h.sprite();
  const first = new c.PIXI.filters.BlurFilter(4, 2);
  const second = new c.PIXI.filters.BlurFilter(8, 2);
  node._filters = [first];
  Object.defineProperty(first, 'enabled', { get() {
    if (node._filters.length === 1) node._filters.push(second);
    return true;
  } });
  let observed;
  c.nativeSceneFilter = (_, filters) => {
    observed = Array.from(filters);
    return { groups: [], blur: 0 };
  };
  c.submitNativeScene(node);
  assert.deepEqual(observed, [first, second]);
});

for (const effects of ['none', 'empty', 'disabled', 'mask']) {
  test(`advanced helper validation follows ordinary dispatch: ${effects}`, () => {
    const h = makeHarness(), c = h.sandbox, root = new c.PIXI.Container();
    for (let i = 0; i < 8; i++) root.addChild(h.sprite());
    const node = root.children[0];
    node.renderAdvancedWebGL = () => { throw new Error('unsupported helper invoked'); };
    if (effects === 'empty') node._filters = [];
    if (effects === 'disabled') node._filters = [{ enabled: false }];
    if (effects === 'mask') node._mask = {};
    if (effects === 'none') {
      c.submitNativeScene(root);
      assert.equal(h.submitted.length, 1);
    } else {
      assert.throws(() => c.submitNativeScene(root), /render\.render-method: Sprite\.renderAdvancedWebGL/);
      assert.equal(h.submitted.length, 0);
    }
  });
}

test('preparation and earlier siblings can change the reached advanced helper', () => {
  for (const duringText of [false, true]) {
    const h = makeHarness({ beforeWriter(c) {
      c.PIXI.Text = class Text extends c.PIXI.Sprite {};
    } });
    const c = h.sandbox, root = new c.PIXI.Container();
    const text = root.addChild(new c.PIXI.Text(h.makeTexture(16, 16)));
    const target = duringText ? text : root.addChild(h.sprite());
    text.updateText = () => {
      target._filters = [];
      target.renderAdvancedWebGL = () => {};
    };
    assert.throws(() => c.submitNativeScene(root), /renderAdvancedWebGL/);
    assert.equal(h.submitted.length, 0);
  }
});

test('advanced helper inventory is nonfatal and effective prototype changes remain live', () => {
  const h = makeHarness(), c = h.sandbox, node = h.sprite();
  c.PIXI.Sprite.prototype.renderAdvancedWebGL = () => {};
  assert.doesNotThrow(() => c.pmjsPixiRenderPreflight.scan());
  assert.ok(c.pmjsPixiRenderPreflight.report.renderMethodOverrides.includes('Sprite.renderAdvancedWebGL'));
  c.submitNativeScene(node);
  node._filters = [];
  assert.throws(() => c.submitNativeScene(node), /renderAdvancedWebGL/);
  assert.equal(h.submitted.length, 1);
});

test('Text preparation cannot conceal a changed delegated Container entry point', () => {
  const h = makeHarness({ beforeWriter(c) {
    c.PIXI.Text = class Text extends c.PIXI.Sprite {};
  } });
  const c = h.sandbox, node = new c.PIXI.Text(h.makeTexture(16, 16));
  node.updateText = () => { c.PIXI.Container.prototype.renderWebGL = () => {}; };
  assert.throws(() => c.submitNativeScene(node), /render\.render-method: Text\.renderWebGL/);
  assert.equal(h.submitted.length, 0);
});

test('leaf preparation does not change an already selected advanced helper', () => {
  const h = makeHarness({ beforeWriter(c) {
    c.PIXI.mesh.Mesh.prototype.refresh = function() {
      this.renderAdvancedWebGL = () => {};
    };
  } });
  const c = h.sandbox, node = new c.PIXI.mesh.Mesh();
  node._filters = [];
  c.submitNativeScene(node);
  assert.equal(h.submitted.length, 1);
  assert.throws(() => c.submitNativeScene(node), /renderAdvancedWebGL/);
});

test('realized bitmap caches ignore original helpers and validate snapshot drawing', () => {
  const h = makeHarness({ beforeWriter(c) {
    c.PIXI.DisplayObject.prototype._renderCachedWebGL = function() {};
  } });
  const c = h.sandbox, node = h.sprite();
  node._filters = [];
  node.renderAdvancedWebGL = () => {};
  node._cacheAsBitmap = true;
  node._cacheData = { originalRenderWebGL: node.renderWebGL, sprite: h.sprite() };
  node.renderWebGL = node._renderCachedWebGL;
  c.submitNativeScene(node);
  assert.equal(h.submitted.length, 1);
  node._cacheData.sprite._filters = [];
  node._cacheData.sprite.renderAdvancedWebGL = () => {};
  assert.throws(() => c.submitNativeScene(node), /renderAdvancedWebGL/);
  node.__pmjsBuildingBitmapCache = true;
  node._cacheData.sprite = null;
  assert.throws(() => c.submitNativeScene(node), /renderAdvancedWebGL/);
  assert.equal(h.submitted.length, 1);
});

test('WindowLayer reads public filters after area preparation and skips empty layers', () => {
  const h = makeHarness(), c = h.sandbox, layer = new c.WindowLayer();
  const calls = [];
  layer.filterArea = { copy() { calls.push('area'); } };
  Object.defineProperty(layer, 'filters', { get() { calls.push('filters'); return []; } });
  c.submitNativeScene(layer);
  assert.deepEqual(calls, []);
  layer.addChild(h.sprite());
  layer.renderAdvancedWebGL = () => { throw new Error('unreached helper'); };
  c.submitNativeScene(layer);
  assert.deepEqual(calls, ['area', 'filters']);
});

test('dedicated particle and composite tile renderers never read filters or advanced helpers', () => {
  const h = makeHarness({ beforeWriter(c) {
    c.PIXI.tilemap.CompositeRectTileLayer = class extends c.PIXI.Container {};
  } });
  const c = h.sandbox;
  for (const Ctor of [c.PIXI.particles.ParticleContainer, c.PIXI.tilemap.CompositeRectTileLayer]) {
    const node = new Ctor();
    Object.defineProperty(node, 'filters', { get() { throw new Error('public filter read'); } });
    Object.defineProperty(node, '_filters', { get() { throw new Error('backing filter read'); } });
    Object.defineProperty(node, 'renderAdvancedWebGL', { get() { throw new Error('advanced helper read'); } });
    node.addChild(h.sprite());
    c.submitNativeScene(node);
  }
  assert.equal(h.submitted.length, 2);
});
