nativeBootPhase('adapter-ready');
var pmjsMvRuntimeGame = globalThis.PMJS_RUNTIME_GAME;
NativeHost.runtime.loadScript(pmjsMvRuntimeGame ?
  pmjsMvRuntimeGame.pixiPath : 'js/libs/pixi.js');
if (!globalThis.PIXI || typeof PIXI.Container !== 'function') {
  throw new Error('Pixi object model did not initialize');
}
if (pmjsMvRuntimeGame && PIXI.VERSION !== pmjsMvRuntimeGame.pixiVersion) {
  throw new Error('inspected Pixi ' + pmjsMvRuntimeGame.pixiVersion +
    ' but loaded ' + PIXI.VERSION);
}
NativeHost.runtime.loadScript(pmjsMvRuntimeGame ?
  pmjsMvRuntimeGame.pixiTilemapPath : 'js/libs/pixi-tilemap.js');
// Retain compiled tile layers to avoid per-tile JS/native calls every frame.
if (PIXI.tilemap && PIXI.tilemap.RectTileLayer) {
  (function() {
    var proto = PIXI.tilemap.RectTileLayer.prototype;
    var clear = proto.clear;
    proto.clear = function() {
      this._pmjsNativeGeneration = (this._pmjsNativeGeneration || 0) + 1;
      return clear.apply(this, arguments);
    };
    var destroy = proto.destroy;
    proto.destroy = function() {
      if (this._pmjsNativeLayer) {
        if (typeof pmjsReleaseNativeGeometry === 'function')
          pmjsReleaseNativeGeometry(this, 'tile');
        else {
          NativeHost.render.releaseTileLayer(this._pmjsNativeLayer);
          this._pmjsNativeLayer = 0;
        }
      }
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
if (PIXI.mesh && PIXI.mesh.Mesh) {
  (function() {
    var proto = PIXI.mesh.Mesh.prototype;
    var destroy = proto.destroy;
    proto.destroy = function() {
      if (this.__pmjsNativeMesh) {
        if (typeof pmjsReleaseNativeGeometry === 'function')
          pmjsReleaseNativeGeometry(this, 'mesh');
        else {
          NativeHost.render.releaseMesh(this.__pmjsNativeMesh);
          this.__pmjsNativeMesh = 0;
        }
      }
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
if (PIXI.particles && PIXI.particles.ParticleContainer) {
  (function() {
    var proto = PIXI.particles.ParticleContainer.prototype;
    var destroy = proto.destroy;
    proto.destroy = function() {
      var result = destroy && destroy.apply(this, arguments);
      this.__pmjsParticleValues = null;
      this.__pmjsParticleBufferRevisions = null;
      this.__pmjsParticleProperties = null;
      return result;
    };
  })();
}
if (PIXI.Graphics) {
  (function() {
    var destroy = PIXI.Graphics.prototype.destroy;
    PIXI.Graphics.prototype.destroy = function() {
      var canvas = this.__pmjsGraphicsCanvas;
      var maskCanvas = this.__pmjsGraphicsMaskCanvas;
      if (canvas) canvas._releaseNativeCanvas();
      if (maskCanvas && maskCanvas !== canvas) maskCanvas._releaseNativeCanvas();
      this.__pmjsGraphicsCanvas = null;
      this.__pmjsGraphicsMaskCanvas = null;
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
if (PIXI.Texture) {
  (function() {
    var destroy = PIXI.Texture.prototype.destroy;
    PIXI.Texture.prototype.destroy = function() {
      if (this.__pmjsTilingCanvas) {
        this.__pmjsTilingCanvas._releaseNativeCanvas();
        this.__pmjsTilingCanvas = null;
      }
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
function installNativePictureTilingSprite() {
  var Original = PIXI.extras && PIXI.extras.PictureTilingSprite;
  if (!Original || Original.__pmjsNativeTilingSprite) return;
  function PictureTilingSprite(texture) {
    Original.call(this, texture);
    // pixi-picture labels both sprite classes as "picture". Preserve the
    // tiling leaf identity so PictureTilingSprite reaches tiled rendering.
    this.pluginName = 'tilingsprite';
  }
  PictureTilingSprite.prototype = Object.create(Original.prototype);
  PictureTilingSprite.prototype.constructor = PictureTilingSprite;
  PictureTilingSprite.__pmjsNativeTilingSprite = true;
  PIXI.extras.PictureTilingSprite = PictureTilingSprite;
}
function releaseNativeRenderCanvas(baseTexture) {
  var renderTargets = baseTexture && baseTexture._glRenderTargets;
  if (renderTargets) {
    Object.keys(renderTargets).forEach(function(key) {
      var target = renderTargets[key];
      if (target && typeof target.destroy === 'function') target.destroy();
      delete renderTargets[key];
    });
  }
  var source = baseTexture && baseTexture.__pmjsRenderCanvas;
  if (!source) return;
  source._releaseNativeCanvas();
  baseTexture.__pmjsRenderCanvas = null;
  if (baseTexture.source === source) baseTexture.source = null;
}
if (PIXI.BaseTexture) {
  (function() {
    var destroy = PIXI.BaseTexture.prototype.destroy;
    PIXI.BaseTexture.prototype.destroy = function() {
      var source = this.source;
      var result = destroy && destroy.apply(this, arguments);
      if (source && source._pmjsOwnedTextureSource &&
          source instanceof NativeImage) source.src = '';
      return result;
    };
  })();
}
// Pixi assigns _cacheData.sprite only after it has rendered the node into its cache texture.
// That render goes through the native renderer, whose bitmap-cache preparation finds the same
// node (cacheAsBitmap is already true, the sprite not yet set) and would initialize it again:
// the nested call allocates a second render texture and canvas, its sprite is then overwritten
// by the outer one, and the inner texture is never destroyed. One canvas leaked per cache
// initialization (picture-layer captures re-initialize often), until a 1 GB device ran out of
// memory. A node already being initialized is skipped; while it builds, it is flagged so the
// encoder draws its live children, which is what the outer render needs.
if (PIXI.DisplayObject && typeof PIXI.DisplayObject.prototype._initCachedDisplayObject === 'function') {
  (function() {
    var initialize = PIXI.DisplayObject.prototype._initCachedDisplayObject;
    PIXI.DisplayObject.prototype._initCachedDisplayObject = function(renderer) {
      if (this.__pmjsInitializingBitmapCache) return undefined;
      var building = this.__pmjsBuildingBitmapCache;
      this.__pmjsInitializingBitmapCache = true;
      this.__pmjsBuildingBitmapCache = true;
      try {
        return initialize.call(this, renderer);
      } finally {
        this.__pmjsInitializingBitmapCache = false;
        this.__pmjsBuildingBitmapCache = building;
      }
    };
  })();
}
if (PIXI.BaseRenderTexture) {
  (function() {
    var destroy = PIXI.BaseRenderTexture.prototype.destroy;
    PIXI.BaseRenderTexture.prototype.destroy = function() {
      releaseNativeRenderCanvas(this);
      return destroy && destroy.apply(this, arguments);
    };
  })();
}
NativeHost.runtime.loadScript('js/libs/pixi-picture.js');
installNativePictureTilingSprite();
NativeHost.runtime.loadScript('js/libs/lz-string.js');
NativeHost.runtime.loadScript('js/libs/iphone-inline-video.browser.js');
