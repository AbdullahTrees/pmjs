'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { makeHarness, packetNode } = require('./helpers/scene-encoder-harness.cjs');

const BACKGROUND = 0x102030;

function retainedHarness(options) {
  return makeHarness({ retained: true, ...options });
}

function frame(harness, stage, rootTransform) {
  harness.sandbox.renderNativeStage(stage, rootTransform, 1, false, false, BACKGROUND);
  return harness.submitted.at(-1);
}

// Frame 3 reference: same batching, retention and bulk-clear off so per-record
// zeroing makes packet tails deterministic across frames.
function immediateFrame(harness, stage, rootTransform) {
  harness.sandbox.PMJS.optimizations.isEnabled =
    id => id === 'scene.plain-sprite-segment';
  return frame(harness, stage, rootTransform);
}

function spliced(harness) {
  return harness.sandbox.PMJS.pixi4.retained.stats.splicedRecords;
}

function preparedHarness(options = {}) {
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
    if (options.verify) {
      sandbox.NativeHost.runtime.env = name =>
        name === 'PMJS_RETAINED_VERIFY' ? '1' : undefined;
    }
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
  assert.equal(two.values[2 * 41], 12.5, 'quad corner 0 x tracks the move');
  assert.deepEqual(two, immediateFrame(harness, root));
});

// A rotated projection such as a plugin passes to renderer.render. Under a
// 90° root transform the projected x is 480 - y and the projected y is the
// untransformed x, so only the quad words can see horizontal movement.
const ROTATED = { a: 0, b: 1, c: -1, d: 0, tx: 480, ty: 0 };

function worldScene(harness) {
  const { sandbox } = harness;
  const stage = new sandbox.PIXI.Container();
  const mover = harness.sprite();
  const still = harness.sprite(); still.x = 100;
  stage.addChild(mover); stage.addChild(still);
  return { stage, mover, still };
}

test('world-state sprite quads re-encode when a sprite moves', () => {
  const harness = preparedHarness();
  const { stage, mover } = worldScene(harness);
  const one = frame(harness, stage);
  assert.equal(packetNode(one, 2).flags & 4096, 4096,
    'the prepared quad path ran (anti-vacuity)');
  frame(harness, stage);
  mover.x = 37;
  const three = frame(harness, stage);
  assert.equal(three.values[2 * 41], 37, 'corner 0 x tracks the move');
  assert.deepEqual(three, immediateFrame(harness, stage));
});

test('a rotated root transform must not drop movement from the fingerprint', () => {
  const harness = preparedHarness();
  const { stage, mover } = worldScene(harness);
  frame(harness, stage, ROTATED);
  frame(harness, stage, ROTATED);
  mover.x = 37;
  const three = frame(harness, stage, ROTATED);
  assert.equal(three.values[2 * 41 + 1], 37,
    'projected corner 0 y = untransformed x after the move');
  assert.equal(three.values[2 * 41 + 3], 69,
    'projected corner 1 y = untransformed x + width after the move');
  assert.deepEqual(three, immediateFrame(harness, stage, ROTATED));
});

test('verify mode agrees with the immediate encode under a rotated root', () => {
  const harness = preparedHarness({ verify: true });
  const { stage, mover } = worldScene(harness);
  frame(harness, stage, ROTATED);
  frame(harness, stage, ROTATED);
  mover.x = 37;
  frame(harness, stage, ROTATED);
  assert.equal(harness.sandbox.PMJS.pixi4.retained.stats.mismatched, 0);
  assert.equal(harness.sandbox.PMJS.pixi4.retained.verifyActive(), true);
});

function verifyHarness() {
  return retainedHarness({ beforeWriter(sandbox) {
    sandbox.NativeHost.runtime.env = name =>
      name === 'PMJS_RETAINED_VERIFY' ? '1' : undefined;
  } });
}

test('verify mode runs the whole battery with zero mismatches', async (t) => {
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, () => {
      const harness = verifyHarness();
      const { sandbox } = harness;
      const root = new sandbox.PIXI.Container();
      const group = new sandbox.PIXI.Container();
      const a = harness.sprite();
      const b = harness.sprite();
      root.addChild(group); group.addChild(a); group.addChild(b);

      frame(harness, root);
      mutate({ root, group, a, b, harness, sandbox });
      frame(harness, root);
      assert.equal(sandbox.PMJS.pixi4.retained.stats.mismatched, 0);
      assert.equal(sandbox.PMJS.pixi4.retained.verifyActive(), true);
    });
  }
});

test('verify mode catches a corrupted splice and submits the clean packet', () => {
  const harness = verifyHarness();
  const { sandbox } = harness;
  const root = new sandbox.PIXI.Container();
  const a = harness.sprite();
  const b = harness.sprite();
  root.addChild(a); root.addChild(b);
  frame(harness, root);
  a.x = 5;

  let corrupted = false;
  const retained = sandbox.PMJS.pixi4.retained;
  const realSplice = retained.splice;
  retained.splice = function(node, parentIndex, ...rest) {
    const ok = realSplice.call(this, node, parentIndex, ...rest);
    if (ok && !corrupted) {
      corrupted = true;
      sandbox.nativeSceneMetadata[(sandbox.nativeSceneCount - 1) * 7] ^= 8;
    }
    return ok;
  };
  frame(harness, root);
  assert.equal(corrupted, true, 'the untouched sibling spliced');
  assert.equal(retained.stats.mismatched, 1);
  assert.equal(retained.verifyActive(), false, 'verify falls back after a mismatch');

  const clean = makeHarness();
  const other = new clean.sandbox.PIXI.Container();
  const otherA = clean.sprite();
  const otherB = clean.sprite();
  other.addChild(otherA); other.addChild(otherB);
  otherA.x = 5;
  clean.sandbox.renderNativeStage(other, undefined, 1, false, false, BACKGROUND);
  assert.deepEqual(harness.submitted.at(-1), clean.submitted.at(-1),
    'the submitted packet is the uncorrupted immediate encode');
});

test('verify mode reports zero mismatches under random churn', () => {
  const harness = verifyHarness();
  const { sandbox } = harness;
  const stats = sandbox.PMJS.pixi4.retained.stats;
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = size => Math.floor(rand() * size);

  const root = new sandbox.PIXI.Container();
  const containers = [root];
  const nodes = [root];
  const addNode = () => {
    const parent = containers[pick(containers.length)];
    if (rand() < 0.35 && containers.length < 8) {
      const branch = new sandbox.PIXI.Container();
      parent.addChild(branch); containers.push(branch); nodes.push(branch);
    } else {
      const leaf = harness.sprite(16 + pick(48), 16 + pick(48));
      parent.addChild(leaf); nodes.push(leaf);
    }
  };
  for (let index = 0; index < 12; index++) addNode();

  const mutate = () => {
    const ops = 1 + pick(6);
    for (let op = 0; op < ops; op++) {
      const node = nodes[pick(nodes.length)];
      switch (pick(12)) {
        case 0: node.x = pick(200) - 100; break;
        case 1: node.y = pick(200) - 100; break;
        case 2: node.alpha = 0.05 + rand() * 0.95; break;
        case 3: node.tint = pick(0x1000000); break;
        case 4: node.blendMode = pick(4); break;
        case 5: node.visible = rand() < 0.8; break;
        case 6: if (nodes.length < 30) addNode(); break;
        case 7: {
          const parent = containers[pick(containers.length)];
          if (parent.children.length) {
            const removed = parent.children.splice(pick(parent.children.length), 1)[0];
            const at = nodes.indexOf(removed);
            if (at >= 0) nodes.splice(at, 1);
          }
          break;
        }
        case 8: {
          const parent = containers[pick(containers.length)];
          if (parent.children.length > 1) parent.children.reverse();
          break;
        }
        case 9: if (node.texture) node.texture.frame.x = pick(8); break;
        case 10: if (node.texture) node.anchor.x = rand(); break;
        case 11: if (node.texture) node.texture.baseTexture.resolution = 1 + pick(3); break;
      }
    }
  };

  for (let iteration = 0; iteration < 1000; iteration++) {
    mutate();
    frame(harness, root);
    assert.equal(stats.mismatched, 0, 'mismatch at frame ' + iteration);
  }
  assert.equal(stats.frames, 1000);
  assert.equal(stats.phaseA, 1000, 'verify probes every frame');
  assert.equal(stats.splicedRecords > 0, true);
  assert.equal(sandbox.PMJS.pixi4.retained.verifyActive(), true);
});

test('static scenes run the signature walk every frame', () => {
  const harness = retainedHarness();
  const { sandbox } = harness;
  const stats = sandbox.PMJS.pixi4.retained.stats;
  const root = new sandbox.PIXI.Container();
  const group = new sandbox.PIXI.Container();
  root.addChild(group);
  group.addChild(harness.sprite());
  group.addChild(harness.sprite());

  for (let iteration = 0; iteration < 20; iteration++) frame(harness, root);
  assert.equal(stats.frames, 20);
  assert.equal(stats.phaseA, 20, 'a hot scene walks every frame');
  assert.equal(stats.probes, 1,
    'only frame 2 probes, before the scene is known splicable');
});

test('full churn pays for the walk in bursts, not every frame', () => {
  const harness = retainedHarness();
  const { sandbox } = harness;
  const stats = sandbox.PMJS.pixi4.retained.stats;
  const root = new sandbox.PIXI.Container();
  const leaves = [];
  for (let index = 0; index < 6; index++) {
    const leaf = harness.sprite();
    root.addChild(leaf); leaves.push(leaf);
  }

  for (let iteration = 0; iteration < 20; iteration++) {
    for (const leaf of leaves) leaf.x = iteration + 1;
    frame(harness, root);
  }
  assert.equal(stats.frames, 20);
  // Probe frames land on 2 and 19, each followed by a harvesting walk; the
  // fifteen frames between run without the signature walk at all.
  assert.equal(stats.probes, 2);
  assert.equal(stats.phaseA, 5);
});
