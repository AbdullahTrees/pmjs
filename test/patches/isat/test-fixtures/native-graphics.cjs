'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const adapter = fs.readFileSync(path.resolve(__dirname, '../../../../patches/isat/mpp-gpu-fragments.js'), 'utf8');
const registry = fs.readFileSync(path.resolve(__dirname, '../../../../js/pmjs-core/optimizations.js'), 'utf8');

function createGraphics({ disables = [], via = 'config', rendererReady = true, yepPosition = false } = {}) {
  const retained = [], invalidated = [], released = [], cleared = [], hooks = [];
  let sorts = 0;
  function Container() { this.children = []; this.scale = { x: 1, y: 1 }; }
  Container.prototype.addChild = function(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
  };
  Container.prototype.destroy = function() {};
  function Sprite() { this.initialize(); }
  Sprite.prototype = Object.create(Container.prototype);
  Sprite.prototype.initialize = function() { Container.call(this); this.anchor = { x: 0, y: 0 };
    this.worldTransform = { identity() {} }; this._blendColor = [0, 0, 0, 0]; };
  Sprite.prototype.updateTransform = function() { this.worldTransform.tx = this.x; this.worldTransform.ty = this.y; };
  function Texture(baseTexture, frame) { this.baseTexture = baseTexture; this.frame = frame; }
  function Mesh(texture, vertices, uvs, indices, drawMode) {
    Container.call(this);
    Object.assign(this, { texture, vertices, uvs, indices, drawMode, indexDirty: 0 });
  }
  Mesh.prototype = Object.create(Container.prototype);
  Mesh.DRAW_MODES = { TRIANGLES: 1 };
  const context = {
    console: { warn() {} }, SceneManager: { snap() { return 'canvas'; } },
    performance: { now: () => 10 }, Sprite,
    PIXI: { Container, Sprite: { prototype: { updateTransform: Sprite.prototype.updateTransform } }, mesh: { Mesh }, Texture,
      SCALE_MODES: { NEAREST: 0, LINEAR: 1 }, Rectangle: function(x, y, width, height) {
        Object.assign(this, { x, y, width, height });
      } },
    Graphics: { isWebGL: () => true, width: 80, height: 60, _renderer: {
      generateTextureGpu(stage, mode, resolution, region) {
        context.capture = { stage, mode, resolution, region };
        if (context.failCapture) throw new Error('capture failed');
        return { width: region.width, height: region.height, baseTexture: { scaleMode: mode }, destroys: 0,
          destroy() { this.destroys++; context.released = true; } };
      }
    } },
    NativeHost: { runtime: { env(name) {
      return name === 'PMJS_DISABLE_OPT' && via === 'env' ? disables.join(',') : undefined;
    } } },
    PMJS: { isatSourceQualification: { verified: true }, isatSourcePatches: { register() {} }, config: { disableOptimizations: via === 'config' ? disables : [] },
      phases: { on(_phase, _id, callback) { hooks.push(callback); } },
      pixi4: {
        supportsGpuSpriteTextures: true,
        createGpuStandaloneBitmapRegion(texture, rectangle) { return new Texture(texture.baseTexture, rectangle); },
        clearBackground(texture, points) { cleared.push({ texture, points: Array.from(points) }); },
        retainMeshGeometry(mesh) { retained.push(mesh); },
        invalidateMeshGeometry(mesh) { invalidated.push(mesh); },
        setTriangleBitmap(mesh, d) { mesh.paint = d.points.flat().concat(d.sourceBounds, d.stroke.color, [d.stroke.alpha,d.stroke.width,d.stroke.miterLimit]); mesh.strokeSamples = 4; },
        releaseSceneResources(root) { released.push(root); },
      } }
  };
  context.PMJS.plugins = { mpp: {
    sortFragments(values, compare) { sorts++; return Array.prototype.sort.call(values, compare); },
    clearBackground: context.PMJS.pixi4.clearBackground,
    setTriangleBitmap: context.PMJS.pixi4.setTriangleBitmap
  } };
  const renderOptions = new WeakMap();
  context.PMJS.pixi4.getStageRenderOptions = stage => renderOptions.get(stage);
  context.PMJS.pixi4.setStageRenderOptions = (stage, value) => {
    const previous=renderOptions.get(stage);
    if (value) renderOptions.set(stage,value); else renderOptions.delete(stage);
    return previous;
  };
  const renderer = context.Graphics._renderer;
  if (!rendererReady) context.Graphics._renderer = null;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(registry, context);
  context.PMJS.optimizations.register({ id: 'sprite.native-tint', owner: 'test', fallback: 'canvas' });
  context.Yanfly = { Core: { Sprite_updateTransform: Sprite.prototype.updateTransform } };
  if (yepPosition) vm.runInContext(`
    Sprite.prototype.updateTransform = function() {
      Yanfly.Core.Sprite_updateTransform.call(this);
      this.worldTransform.tx = Math.floor(this.worldTransform.tx);
      this.worldTransform.ty = Math.floor(this.worldTransform.ty);
    };
  `, context);
  vm.runInContext(adapter, context);
  return { context, hooks, retained, invalidated, released, cleared, renderer, sorts: () => sorts };
}

module.exports = { createGraphics };
