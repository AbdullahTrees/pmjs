'use strict';
process.env.PMJS_GRAPHICS_DIAGNOSTICS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), width: 32, height: 32, windowTitle: 'filter intermediate cache' });
const source = native.canvas.create(16, 16), snapshot = native.canvas.create(32, 32);
const pixels = Uint8Array.from({ length: 16 * 16 * 4 }, (_, i) =>
  i % 4 === 3 ? 32 + (i % 223) : (i * 13) % 256);
native.canvas.writePixels(source.handle, 0, 0, 16, 16, pixels);
const vertex = 'attribute vec2 aVertexPosition; attribute vec2 aTextureCoord; uniform mat3 projectionMatrix; varying vec2 vTextureCoord; void main(){gl_Position=vec4((projectionMatrix*vec3(aVertexPosition,1.0)).xy,0,1);vTextureCoord=aTextureCoord;}';
const fragment = 'varying vec2 vTextureCoord; uniform sampler2D uSampler; uniform float amount; void main(){vec4 c=texture2D(uSampler,vTextureCoord); gl_FragColor=vec4(c.b,c.r,c.g,c.a)*amount;}';
const program = native.render.createFilterProgram(fragment, vertex);
const schema = native.scene.schema;
function render(enabled, options = {}) {
  const { amount = 0.83, alpha = 1, x = 3, backdrop = 0.25, blend = 0,
    frame = [3, 2, 16, 16], resolution = 1, offscreen = false, image = source, uniformClasses } = options;
  const description = { frame, resolutions: [resolution, 1, resolution], passes: [
    { program: program.handle, input: 0, output: 2, clear: true, blend: 0, uniforms: [amount], uniformClasses, samplers: [] },
    { program: program.handle, input: 2, output: 0, clear: true, blend: 0, uniforms: [0.91], samplers: [] },
    { program: program.handle, input: 0, output: 2, clear: true, blend: 0, uniforms: [0.94], samplers: [] },
    { program: program.handle, input: 2, output: 1, clear: false, blend, uniforms: [1], samplers: [] },
  ] };
  if (!uniformClasses) delete description.passes[0].uniformClasses;
  const plan = native.render.createFilterPlan(description);
  const metadata = [], values = [];
  function record(kind, parent, resource, filter = 0) {
    metadata.push(kind, parent, resource, 0xffffff, filter, 0, 0);
    const row = new Array(schema.valueStride).fill(0);
    row.splice(0, 7, 1, 0, 0, 1, 0, 0, 1);
    values.push(...row); return values.length - schema.valueStride;
  }
  let offset = record(3, 0xffffffff, 0);
  metadata[3] = Math.round(backdrop * 255) * 0x010101;
  values.splice(offset + 9, 6, 0, 0, 32, 32, 32, 32);
  offset = record(6, 0xffffffff, plan.handle, 31);
  values[offset + 8] = enabled ? 1 : 0;
  offset = record(1, 1, image.handle);
  values.splice(offset + 4, 3, x, 2, alpha);
  values.splice(offset + 9, 6, 0, 0, 16, 16, 16, 16);
  record(7, 1, 0);
  const before = native.render.stats(), uploads = native.images.memory().textureUploadBytes;
  native.beginFrame();
  native.scene.submit(schema.version, new Uint32Array(metadata), new Float32Array(values), 4);
  let actual;
  if (offscreen) {
    native.render.renderToCanvas(snapshot.handle);
    actual = native.canvas.readPremultipliedPixels(snapshot.handle, 0, 0, 32, 32);
  } else { native.renderScene(); actual = native.canvas.captureSceneRawPremultiplied(); }
  const after = native.render.stats();
  return { pixels: Buffer.from(actual), hits: after.filterIntermediateCacheHits - before.filterIntermediateCacheHits,
    draws: after.filterDrawCalls - before.filterDrawCalls,
    uploadBytes: native.images.memory().textureUploadBytes - uploads };
}
function paired(label, options = {}, eligible = true) {
  const cold = render(true, options), baseline = render(false, options);
  render(true, options);
  const warm = render(true, options);
  assert.deepEqual(cold.pixels, baseline.pixels, label + ': cold');
  assert.deepEqual(warm.pixels, baseline.pixels, label + ': warm');
  assert.equal(cold.hits, 0, label + ': invalidation');
  assert.equal(warm.hits, eligible ? 1 : 0, label + ': reuse');
  assert.equal(warm.draws, eligible ? 1 : 4, label + ': passes');
  assert.equal(warm.uploadBytes, 0, label + ': uploads');
}
paired('translucent source');
const animationBefore = native.render.stats();
let animated;
for (let frame = 0; frame < 12; frame++) {
  animated = render(true, { amount: 0.5 + frame * 0.01 });
  assert.equal(animated.hits, 0, 'animated input renders live');
  assert.equal(animated.draws, 4, 'animated input retains authored passes');
}
assert.equal(native.render.stats().rendererTargetCreates, animationBefore.rendererTargetCreates,
  'animated input does not allocate recurring targets');
assert.equal(native.render.stats().rendererTargetDestroys, animationBefore.rendererTargetDestroys,
  'animated input does not destroy recurring targets');
assert.deepEqual(animated.pixels, render(false, { amount: 0.61 }).pixels);
render(true); render(true);
// Destination content is deliberately excluded: the final blend stays live.
const changedBackdrop = render(true, { backdrop: 0.7 });
assert.equal(changedBackdrop.hits, 1);
assert.deepEqual(changedBackdrop.pixels, render(false, { backdrop: 0.7 }).pixels);
for (const [label, options] of Object.entries({ uniform: { amount: 0.44 },
  opacity: { alpha: 0.5 }, position: { x: 4 }, frame: { frame: [2, 1, 18, 20] },
  blend: { blend: 1 }, resolution: { resolution: 2 }, offscreen: { offscreen: true } })) {
  paired(label, options, !['resolution', 'offscreen'].includes(label));
}
render(true); render(true);
native.canvas.fillRect(source.handle, 2, 2, 3, 4, 1, 0, 0, 1);
paired('source mutation');
for (const classification of [1, 2, 3]) {
  paired('uniform classification ' + classification, { amount: 0, uniformClasses: [classification] });
}
const replacement = native.canvas.create(16, 16);
native.canvas.writePixels(replacement.handle, 0, 0, 16, 16, pixels);
paired('source replacement', { image: replacement });
native.beginFrame(); native.render.quad(0, 0, 16, 16, 0, 0, 1, 0.5);
const generated = native.render.renderToImage(32, 32);
paired('untracked framebuffer source', { image: generated }, false);
native.images.release(generated.handle);
render(true); render(true);
// A frame with no eligible chain releases the retained intermediate storage.
const before = native.render.stats().rendererTargetBytes;
native.beginFrame(); native.render.quad(0, 0, 32, 32, 1, 0, 0, 1); native.renderScene();
assert.equal(before - native.render.stats().rendererTargetBytes, 16 * 16 * 4);
paired('re-entry');
for (const canvas of [source, replacement, snapshot]) native.canvas.release(canvas.handle);
native.runtime.quit();
