'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {makeHarness} = require('./helpers/scene-encoder-harness.cjs');
function setup(destroy) {
  class ParticleContainer {}
  ParticleContainer.prototype.destroy = destroy;
  const context = {
    nativeBootPhase() {},
    NativeHost: {runtime: {loadScript() {}}},
    PIXI: {Container: class {}, particles: {ParticleContainer}}
  };
  context.globalThis = context;
  const source = fs.readFileSync(path.join(__dirname, '../js/pmjs-pixi4/setup.js'), 'utf8');
  vm.runInNewContext(
    source.slice(0, source.indexOf("NativeHost.runtime.loadScript('js/libs/pixi-picture.js')")),
    context);
  return new ParticleContainer();
}

test('particle destroy preserves its call and return before releasing PMJS snapshots', () => {
  const marker = {}, options = {};
  const node = setup(function(value) {
    assert.equal(this, node);
    assert.equal(value, options);
    assert.equal(this.__pmjsParticleValues.length, 1);
    return marker;
  });
  node.__pmjsParticleValues = [{node: {}}];
  node.__pmjsParticleBufferRevisions = [1];
  node.__pmjsParticleProperties = [true];
  node.other = marker;
  assert.equal(node.destroy(options), marker);
  assert.equal(node.__pmjsParticleValues, null);
  assert.equal(node.__pmjsParticleBufferRevisions, null);
  assert.equal(node.__pmjsParticleProperties, null);
  assert.equal(node.other, marker);
});

test('throwing particle destroy retains original exception and unfinished snapshots', () => {
  const error = new Error('sentinel');
  const node = setup(function() { throw error; });
  const values = node.__pmjsParticleValues = [{}];
  assert.throws(() => node.destroy(), candidate => candidate === error);
  assert.equal(node.__pmjsParticleValues, values);
});
for (const legacy of [true, false]) {
  test(
    `invalidated empty ${legacy ? 'legacy' : 'modern'} particles release removed snapshots`, () => {
      const h = makeHarness(), c = h.sandbox, node = new c.PIXI.particles.ParticleContainer();
      if (legacy) {
        delete node._bufferUpdateIDs;
        node._bufferToUpdate = 0;
      }
      for (let i = 0; i < 5; i++) node.addChild(h.sprite());
      c.encodeNativeScene(node);
      assert.equal(node.__pmjsParticleValues.length, 5);
      node.children.length = 0;
      if (legacy)
        node._bufferToUpdate = 0;
      else {
        node._updateID++;
        node._bufferUpdateIDs[0] = node._updateID;
      }
      c.encodeNativeScene(node);
      assert.equal(node.__pmjsParticleValues.length, 0);
    });
}

for (const legacy of [true, false]) {
  test(
    `${legacy ? 'legacy' : 'modern'} tail cleanup preserves static batches and reusable sprites`,
    () => {
      const h = makeHarness(), c = h.sandbox;
      const container = new c.PIXI.particles.ParticleContainer();
      container._batchSize = 3;
      container._properties = [false, false, false, false, false];
      if (legacy) {
        delete container._bufferUpdateIDs;
        container._bufferToUpdate = 0;
      }
      const children = Array.from({length: 7}, (_, index) => {
        const child = container.addChild(h.sprite());
        child.position = {x: index, y: 0};
        return child;
      });
      const retainedTexture = children[6].texture;
      function positions() {
        c.submitNativeScene(container);
        return h.submitted.at(-1).values.filter((_, index) => index % 41 === 4).slice(1);
      }
      function invalidate(index) {
        const batch = Math.floor(index / container._batchSize);
        if (legacy)
          container._bufferToUpdate = Math.min(container._bufferToUpdate, batch);
        else
          container._bufferUpdateIDs[batch] = ++container._updateID;
      }
      assert.deepEqual(positions(), [0, 1, 2, 3, 4, 5, 6]);
      children.forEach(child => {
        child.position.x += 10;
      });
      container._maxSize = 2;
      assert.deepEqual(positions(), [0, 1]);
      assert.equal(container.__pmjsParticleValues.length, 7, 'size limit is not child removal');
      container._maxSize = 10;
      // Legacy Pixi dirties the batches skipped while the size limit was lower.
      assert.deepEqual(positions(), legacy ? [0, 1, 2, 13, 14, 15, 16] : [0, 1, 2, 3, 4, 5, 6]);
      container.children.length = 6;
      invalidate(6);
      assert.deepEqual(positions(), legacy ? [0, 1, 2, 13, 14, 15] : [0, 1, 2, 3, 4, 5]);
      assert.equal(container.__pmjsParticleValues.length, 6);
      container.children.length = 4;
      invalidate(4);
      assert.deepEqual(positions(), [0, 1, 2, 13]);
      assert.equal(container.__pmjsParticleValues.length, 4);
      container.children.push(children[4], children[5]);
      invalidate(4);
      assert.deepEqual(positions(), [0, 1, 2, 13, 14, 15]);
      container.children.length = 1;
      positions();
      assert.equal(
        container.__pmjsParticleValues.length, 6, 'uninvalidated edits retain static snapshots');
      children.forEach(child => {
        child.position.x += 10;
      });
      container.children.push(children[1], children[2]);
      assert.deepEqual(positions(), [0, 1, 2]);
      container.children.length = 0;
      invalidate(0);
      assert.deepEqual(positions(), []);
      assert.equal(container.__pmjsParticleValues.length, 0);
      container.children.push(...children);
      invalidate(0);
      assert.deepEqual(positions(), [20, 21, 22, 23, 24, 25, 26]);
      assert.equal(children[6].texture, retainedTexture, 'cleanup must preserve reusable textures');
    });
}
