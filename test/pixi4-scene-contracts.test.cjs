'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { makeHarness } = require('./helpers/scene-encoder-harness.cjs');

function filterFixture() {
  const h = makeHarness(), c = h.sandbox;
  c.Graphics = { width: 32, height: 32 };
  c.NativeHost.render.createFilterProgram = () => ({ handle: 900, uniforms: [] });
  const plans = [];
  c.NativeHost.render.createFilterPlan = plan => { plans.push(plan); return { handle: 901 }; };
  const filter = { fragmentSrc: 'fragment', vertexSrc: 'vertex', uniforms: {},
    padding: 0, resolution: 1, autoFit: true,
    apply(manager, input, output, clear) { manager.applyFilter(this, input, output, clear); } };
  return { ...h, filter, plans };
}

for (const nestedSize of [2, 600]) {
  test(`nested filter rendering preserves outer packet storage with ${nestedSize} inner sprites`, () => {
    const h = filterFixture(), c = h.sandbox;
    const outer = new c.PIXI.Container(), inner = new c.PIXI.Container();
    const filtered = h.sprite();
    filtered.filterArea = { x: 0, y: 0, width: 16, height: 16 };
    filtered._filters = [h.filter];
    outer.addChild(h.sprite()).x = 11;
    outer.addChild(filtered).x = 22;
    outer.addChild(h.sprite()).x = 33;
    for (let i = 0; i < nestedSize; i++) inner.addChild(h.sprite()).x = i;
    c.submitNativeScene(outer);
    const expected = h.submitted.pop();
    const apply = h.filter.apply;
    h.filter.apply = function(...args) { c.submitNativeScene(inner); return apply.apply(this, args); };
    c.submitNativeScene(outer);
    assert.equal(h.submitted[0].count, nestedSize + 1);
    assert.deepEqual(h.submitted[1], expected);
    assert.equal(c.nativeSceneEncodingDepth, 0);
  });
}

test('caught nested encoding failure restores the enclosing packet and filter depth', () => {
  const h = filterFixture(), c = h.sandbox;
  const outer = new c.PIXI.Container(), inner = new c.PIXI.Container();
  const filtered = outer.addChild(h.sprite());
  filtered.filterArea = { x: 0, y: 0, width: 16, height: 16 };
  filtered._filters = [h.filter];
  inner.addChild(h.sprite())._renderWebGL = () => {};
  const apply = h.filter.apply;
  h.filter.apply = function(...args) {
    assert.throws(() => c.submitNativeScene(inner), /render.render-method/);
    return apply.apply(this, args);
  };
  c.submitNativeScene(outer);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].count, 4);
  assert.equal(c.nativeSceneFilterDepth, 0);
});

test('Pixi 4.5 particle invalidation refreshes static fields from the first changed batch onward', () => {
  const h = makeHarness(), c = h.sandbox;
  const container = new c.PIXI.particles.ParticleContainer();
  delete container._bufferUpdateIDs;
  container._bufferToUpdate = 0;
  container._batchSize = 1;
  container._properties = [false, false, false, false, false];
  for (let i = 0; i < 3; i++) {
    const child = container.addChild(h.sprite());
    child.position = { x: i, y: 0 };
  }
  const positions = () => {
    c.submitNativeScene(container);
    return h.submitted.at(-1).values.filter((_, index) => index % 41 === 4).slice(1);
  };
  assert.deepEqual(positions(), [0, 1, 2]);
  container.children.forEach(child => { child.position.x += 10; });
  assert.deepEqual(positions(), [0, 1, 2]);
  container._bufferToUpdate = 1;
  assert.deepEqual(positions(), [0, 11, 12]);
  assert.equal(container._bufferToUpdate, 3);
});

test('segmented sprites bind each distinct texture and refresh its renderer bookkeeping', () => {
  const h = makeHarness(), c = h.sandbox;
  const root = new c.PIXI.Container(), texture = h.makeTexture(16, 16);
  for (let i = 0; i < 8; i++) root.addChild(new c.PIXI.Sprite(texture));
  const binds = [];
  c.renderNativeStage(root, null, 1, false, false, null,
    { worldState: 'local', renderer: { bindTexture(base) { binds.push(base); base.touched = 42; } } });
  assert.deepEqual(binds, [texture.baseTexture]);
  assert.equal(texture.baseTexture.touched, 42);
});

test('short sprite tails never enter segment eligibility probing', () => {
  const h = makeHarness(), c = h.sandbox, root = new c.PIXI.Container();
  for (let i = 0; i < 3; i++) root.addChild(h.sprite());
  c.nativePlainSpriteBinding = () => { throw new Error('short segment was probed'); };
  c.submitNativeScene(root);
  assert.equal(h.submitted[0].count, 4);
});

test('zero scale does not conceal a reached unsupported render hook', () => {
  const h = makeHarness(), c = h.sandbox, node = h.sprite();
  node.scale = { x: 0, y: 1 };
  node._renderWebGL = () => {};
  assert.throws(() => c.submitNativeScene(node), /render.render-method/);
  assert.equal(h.submitted.length, 0);
});

test('late instance and prototype filter accessors replace formerly direct filter access', () => {
  const h = makeHarness(), c = h.sandbox, node = h.sprite();
  c.submitNativeScene(node);
  let reads = 0;
  Object.defineProperty(node, 'filters', { configurable: true, get() { reads++; return []; } });
  c.submitNativeScene(node);
  assert.ok(reads > 0);
  delete node.filters;
  const before = reads;
  Object.defineProperty(c.PIXI.Sprite.prototype, 'filters', { get() { reads++; return []; } });
  c.submitNativeScene(node);
  assert.ok(reads > before);
});

test('custom filter frames use the active target size and preserve transformed-target fitting semantics', () => {
  const h = filterFixture(), c = h.sandbox;
  c.nativeSceneRenderer = { screen: { width: 32, height: 32 }, _activeRenderTarget: {
    size: { x: 10, y: 20, width: 64, height: 48 }, transform: null } };
  const node = { filterArea: { x: -5.25, y: -7.75, width: 100, height: 80 } };
  c.nativeRecordCustomFilter(h.filter, node);
  assert.deepEqual(Array.from(h.plans[0].frame), [10, 20, 64, 48]);
  c.nativeSceneRenderer._activeRenderTarget.transform = { a: 1, d: 1 };
  c.nativeRecordCustomFilter(h.filter, node);
  assert.deepEqual(Array.from(h.plans[1].frame), [-5, -7, 100, 80]);
});

test('segment eligibility does not call authored filter accessors before their render turn', () => {
  const h = makeHarness(), c = h.sandbox, root = new c.PIXI.Container();
  const reads = [];
  for (let i = 0; i < 8; i++) {
    const child = root.addChild(h.sprite());
    Object.defineProperty(child, 'filters', { get() { reads.push(i); return []; } });
  }
  c.submitNativeScene(root);
  assert.deepEqual(reads, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('resource cleanup visits cycles and shared descendants once without changing release order', () => {
  const h = makeHarness(), c = h.sandbox, released = [];
  c.NativeHost.render.releaseMesh = handle => released.push(handle);
  const first = { __pmjsNativeMesh: 1, children: [] };
  const second = { __pmjsNativeMesh: 2, children: [first] };
  first.children = [second, second];
  assert.equal(c.pmjsReleaseSceneResources(first), 2);
  assert.deepEqual(released, [1, 2]);
});
