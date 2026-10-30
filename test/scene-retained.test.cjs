'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { makeHarness, packetNode } = require('./helpers/scene-encoder-harness.cjs');

const BACKGROUND = 0x102030;

function retainedHarness(options) {
  return makeHarness({ retained: true, ...options });
}

function frame(harness, stage) {
  harness.sandbox.renderNativeStage(stage, undefined, 1, false, false, BACKGROUND);
  return harness.submitted.at(-1);
}

// Frame 3 reference: same batching, retention and bulk-clear off so per-record
// zeroing makes packet tails deterministic across frames.
function immediateFrame(harness, stage) {
  harness.sandbox.PMJS.optimizations.isEnabled =
    id => id === 'scene.plain-sprite-segment';
  return frame(harness, stage);
}

function spliced(harness) {
  return harness.sandbox.PMJS.pixi4.retained.stats.splicedRecords;
}

function preparedHarness(options) {
  const harness = retainedHarness({ beforeWriter(sandbox) {
    const prototype = sandbox.PIXI.Container.prototype;
    Object.defineProperty(prototype, 'worldTransform', {
      get() { return this.transform.worldTransform; }
    });
    prototype.updateTransform = function() {
      this._boundsID++;
      this.transform.updateTransform(this.parent.transform);
      this.worldAlpha = this.alpha * this.parent.worldAlpha;
      for (const child of this.children) if (child.visible) child.updateTransform();
    };
    const sample = new sandbox.PIXI.Container();
    Object.getPrototypeOf(sample.transform).updateTransform = function(parent) {
      this.updateLocalTransform();
      const local = this.localTransform, world = this.worldTransform, outer = parent.worldTransform;
      world.a = outer.a; world.b = outer.b; world.c = outer.c; world.d = outer.d;
      world.tx = outer.a * local.tx + outer.c * local.ty + outer.tx;
      world.ty = outer.b * local.tx + outer.d * local.ty + outer.ty;
      this._worldID = (this._worldID || 0) + 1;
    };
    sandbox.NativeHost.scene.schema.preparedWorldState = true;
  }, ...options });
  harness.sandbox.pmjsPixiRenderPreflight.registerTransformPreparation(
    harness.sandbox.PIXI.Container.prototype.updateTransform, () => {}, () => true);
  return harness;
}

test('static scenes splice every record and stay byte-identical to immediate encoding', () => {
  const harness = retainedHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container();
  const first = harness.sprite(); first.x = 4;
  const second = harness.sprite(); second.alpha = 0.75;
  const group = new sandbox.PIXI.Container(); group.y = 12;
  const inner = harness.sprite(); inner.tint = 0x405060;
  root.addChild(first); root.addChild(second); root.addChild(group);
  group.addChild(inner);

  const one = frame(harness, root);
  assert.equal(one.count, 6, 'background + root + four leaves');
  const two = frame(harness, root);
  assert.deepEqual(two, one, 'spliced frame reuses the previous bytes exactly');
  assert.equal(spliced(harness), 5,
    'every subtree record spliced; the background record is always rewritten');
  const reference = immediateFrame(harness, root);
  assert.deepEqual(two, reference, 'immediate encoding agrees byte for byte');
});

test('unchanged subtrees splice as ranges with rebased parent indices', () => {
  const harness = retainedHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container();
  const branch = new sandbox.PIXI.Container();
  const stable = new sandbox.PIXI.Container();
  branch.addChild(harness.sprite());
  stable.addChild(harness.sprite()); stable.addChild(harness.sprite());
  root.addChild(branch); root.addChild(stable);

  frame(harness, root);
  const before = spliced(harness);
  branch.addChild(harness.sprite());
  const two = frame(harness, root);
  assert.equal(spliced(harness) - before, 4,
    'stable spliced as one range and the branch\'s untouched child spliced alone');
  assert.equal(two.count, 8);
  assert.equal(packetNode(two, 5).parent, 1, 'spliced subtree root rebases to its parent');
  assert.equal(packetNode(two, 6).parent, 5, 'internal parent words shift with the range');
  assert.equal(packetNode(two, 7).parent, 5);
  assert.deepEqual(two, immediateFrame(harness, root));
});

test('a changed descendant invalidates ancestor splices', () => {
  const harness = retainedHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container();
  const group = new sandbox.PIXI.Container();
  const changed = harness.sprite();
  const stable = harness.sprite();
  root.addChild(group); group.addChild(changed); group.addChild(stable);

  frame(harness, root);
  const before = spliced(harness);
  changed.x = 99;
  const two = frame(harness, root);
  assert.equal(spliced(harness) - before, 1, 'only the sibling subtree still splices');
  assert.equal(packetNode(two, 3).x, 99, 'the changed leaf re-encoded');
  assert.equal(packetNode(two, 4).x, 0, 'the unchanged sibling kept its record');
  assert.deepEqual(two, immediateFrame(harness, root));
});

test('buffer growth splices correctly past the initial capacity', () => {
  const harness = retainedHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container();
  for (let index = 0; index < 600; index++) {
    const leaf = harness.sprite(); leaf.x = index;
    root.addChild(leaf);
  }

  const one = frame(harness, root);
  assert.equal(one.count, 602, 'background + root + 600 leaves');
  const before = spliced(harness);
  const two = frame(harness, root);
  assert.equal(spliced(harness) - before, 601, 'the whole grown subtree spliced');
  assert.equal(two.count, 602);
  assert.deepEqual(two, one);
  assert.deepEqual(two, immediateFrame(harness, root));
});

const mutations = {
  'leaf position': ({ a }) => { a.x = 5; a.y = -3; },
  'leaf alpha': ({ a }) => { a.alpha = 0.5; },
  'ancestor alpha': ({ group }) => { group.alpha = 0.25; },
  'leaf tint': ({ a }) => { a.tint = 0x123456; },
  'ancestor tint': ({ group }) => { group.tint = 0x00ff88; },
  'leaf blend mode': ({ a }) => { a.blendMode = 2; },
  'texture swap': ({ a, harness }) => { a.texture = harness.makeTexture(64, 16); },
  'frame offset': ({ a }) => { a.texture.frame.x = 7; },
  'frame size': ({ a }) => { a.texture.frame.width = 20; },
  'anchor': ({ a }) => { a.anchor.x = 0.25; },
  'local matrix': ({ a }) => {
    a.transform.updateLocalTransform = function() {
      this.localTransform = { a: 2, b: 0.5, c: -0.25, d: 1.5,
        tx: (this.owner && this.owner.x) || 0, ty: (this.owner && this.owner.y) || 0 };
    };
  },
  'leaf hidden': ({ a }) => { a.visible = false; },
  'group hidden': ({ group }) => { group.visible = false; },
  'filters': ({ a, sandbox }) => {
    a.filters = [new sandbox.PIXI.filters.BlurFilter(4)];
  },
  'child added': ({ group, harness }) => { group.addChild(harness.sprite(8, 8)); },
  'child removed': ({ group }) => { group.children.pop(); },
  'children reordered': ({ group }) => { group.children.reverse(); },
  'texture resolution': ({ a }) => { a.texture.baseTexture.resolution = 2; },
  'scale mode': ({ a }) => { a.texture.baseTexture.scaleMode = 1; },
  'texture rotation': ({ a }) => { a.texture.rotate = 2; },
  'color tone': ({ a }) => { a._colorTone = [12, -34, 56, 0]; },
  'blend color': ({ a }) => { a._blendColor = [0, 0, 0, 128]; }
};

test('per-field mutations keep retained frames identical to immediate encoding', async (t) => {
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, () => {
      const harness = retainedHarness();
      const { sandbox } = harness;
      const root = new sandbox.PIXI.Container();
      const group = new sandbox.PIXI.Container();
      const a = harness.sprite();
      const b = harness.sprite();
      root.addChild(group); group.addChild(a); group.addChild(b);

      frame(harness, root);
      mutate({ root, group, a, b, harness, sandbox });
      const two = frame(harness, root);
      const reference = immediateFrame(harness, root);
      assert.equal(two.count, reference.count);
      assert.deepEqual(two, reference);
    });
  }
});

test('world-state frames splice and re-encode with byte parity', () => {
  const harness = preparedHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container(); root.x = -4.25; root.alpha = 0.5;
  const mid = new sandbox.PIXI.Container(); mid.x = 2.75;
  const a = harness.sprite(); a.x = 0.5; a.alpha = 0.8;
  const b = harness.sprite(); b.y = 7;
  root.addChild(mid); mid.addChild(a); mid.addChild(b);

  const one = frame(harness, root);
  assert.equal(one.count, 5);
  const two = frame(harness, root);
  assert.deepEqual(two, one);
  assert.equal(spliced(harness), 4, 'background aside, every record spliced');

  a.tint = 0x336699;
  const three = frame(harness, root);
  assert.equal(packetNode(three, 3).color !== packetNode(one, 3).color, true,
    'packed world colour reflects the tint change');
  assert.deepEqual(three, immediateFrame(harness, root));
});

test('world-state leaf movement re-encodes the branch and splices the sibling', () => {
  const harness = preparedHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container(); root.alpha = 0.5;
  const a = harness.sprite(); a.x = 2.75; a.alpha = 0.8;
  const b = harness.sprite(); b.x = 0.5; b.alpha = 0.6;
  root.addChild(a); root.addChild(b);

  frame(harness, root);
  const before = spliced(harness);
  a.x = 12.5;
  const two = frame(harness, root);
  assert.equal(spliced(harness) - before, 1, 'the untouched sibling still splices');
  assert.equal(packetNode(two, 2).x, 12.5);
  assert.deepEqual(two, immediateFrame(harness, root));
});
