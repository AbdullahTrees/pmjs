'use strict';

PMJS.pixi4 = PMJS.pixi4 || {};
PMJS.pixi4.bitmapPresentation = (function() {
  var records = new WeakMap();
  function clear(sprite) {
    var record = records.get(sprite);
    if (!record) return;
    records.delete(sprite);
    if (record.image && record.image.removeEventListener) {
      record.image.removeEventListener('error', record.onError);
    }
    releaseNativeResource(record.resource, 'image');
  }
  function retain(previous, replacement) {
    if (PMJS.config && PMJS.config.preserveBitmapReloadPixels === false ||
        !previous || !replacement || previous.__canvas || replacement.__canvas ||
        !previous.isReady() || replacement.isReady() || !replacement._url ||
        previous._url !== replacement._url || !previous._image ||
        !replacement._image || previous._image._pmjsPreparedTileSet !== replacement._image._pmjsPreparedTileSet ||
        !previous._image._nativeImage || !NativeHost.images.acquireCached) return null;
    var url = replacement._url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:\/\/\/game\//.test(url)) return null;
    var path;
    try { path = decodeResourceUrlPath(url); }
    catch (_) { return null; }
    path = path.replace(/^file:\/\/\/game\//, '').replace(/^\.\//, '');
    if (/^\/|(?:^|\/)\.\.(?:\/|$)/.test(path)) return null;
    var resource;
    try {
      resource = NativeHost.images.acquireCached(path,
        previous._image._pmjsPreparedTileSet || '');
    } catch (error) {
      PMJS.compat.observed('render.bitmap-presentation-miss', String(error.message || error));
      return null;
    }
    if (!resource) return null;
    if (resource.handle !== previous._image._nativeImage.handle) {
      NativeHost.images.release(resource.handle);
      return null;
    }
    return trackNativeResource(resource, 'image');
  }
  var descriptor = Object.getOwnPropertyDescriptor(Sprite.prototype, 'bitmap');
  if (descriptor && descriptor.configurable && descriptor.get && descriptor.set) {
    Object.defineProperty(Sprite.prototype, 'bitmap', {
      configurable: true, enumerable: descriptor.enumerable, get: descriptor.get,
      set: function(value) {
        var previous = descriptor.get.call(this);
        if (previous === value) return descriptor.set.call(this, value);
        clear(this);
        var base = this.texture && this.texture.baseTexture || {};
        descriptor.set.call(this, value);
        var resource = retain(previous, value);
        if (!resource) return;
        var sprite = this;
        var record = { bitmap: value, resource: resource, image: value._image,
          width: previous.width, height: previous.height,
          base: { source: { _nativeImage: resource }, resolution: base.resolution || 1,
            scaleMode: base.scaleMode, mipmap: base.mipmap,
            __pmjsPremultiplied: base.__pmjsPremultiplied } };
        record.onError = function() { if (records.get(sprite) === record) clear(sprite); };
        records.set(sprite, record);
        if (record.image && record.image.addEventListener) record.image.addEventListener('error', record.onError);
        value.addLoadListener(function() { if (records.get(sprite) === record) clear(sprite); });
      }
    });
  }
  var destroy = Sprite.prototype.destroy;
  Sprite.prototype.destroy = function() {
    clear(this);
    if (destroy) return destroy.apply(this, arguments);
  };
  var setFrame = Sprite.prototype.setFrame;
  Sprite.prototype.setFrame = function() {
    var record = records.get(this);
    if (record) record.characterFrame = null;
    return setFrame.apply(this, arguments);
  };
  var refresh = Sprite.prototype._refresh;
  Sprite.prototype._refresh = function() {
    var result = refresh.apply(this, arguments);
    var record = records.get(this);
    if (record && this.bitmap === record.bitmap) {
      var x = Math.floor(this._frame.x), y = Math.floor(this._frame.y);
      record.clippingPivotX = x - Math.max(0, Math.min(this.bitmap.width, x));
      record.clippingPivotY = y - Math.max(0, Math.min(this.bitmap.height, y));
    }
    return result;
  };
  function get(sprite) {
    var record = records.get(sprite);
    if (!record) return null;
    var bitmap = sprite.bitmap;
    if (bitmap !== record.bitmap || bitmap.__canvas || bitmap.isReady() ||
        bitmap.isError && bitmap.isError() ||
        PMJS.config && PMJS.config.preserveBitmapReloadPixels === false) {
      clear(sprite);
      return null;
    }
    var guestFrame = sprite._frame;
    if (guestFrame.x !== 0 || guestFrame.y !== 0 || guestFrame.width !== 0 || guestFrame.height !== 0) {
      record.characterFrame = null;
    }
    var requested = record.characterFrame || guestFrame;
    var x = Math.floor(requested.x), y = Math.floor(requested.y);
    var left = Math.max(0, Math.min(record.width, x));
    var top = Math.max(0, Math.min(record.height, y));
    var width = Math.max(0, Math.min(record.width - left, Math.floor(requested.width) - left + x));
    var height = Math.max(0, Math.min(record.height - top, Math.floor(requested.height) - top + y));
    var frame = { x: left, y: top, width: width, height: height };
    // Correct MV's unloaded-Bitmap clipping pivot; keep the authored pivot.
    return { texture: { baseTexture: record.base, frame: frame, orig: frame, rotate: 0 },
      offsetX: sprite.pivot && sprite.pivot.x === record.clippingPivotX ? record.clippingPivotX - (x - left) : 0,
      offsetY: sprite.pivot && sprite.pivot.y === record.clippingPivotY ? record.clippingPivotY - (y - top) : 0 };
  }
  return { get: get, has: function(sprite) { return records.has(sprite); },
    dimensions: function(sprite) {
      var record = records.get(sprite);
      return record ? { width: record.width, height: record.height } : null;
    },
    setCharacterFrame: function(sprite, bitmap, frame) {
      var record = records.get(sprite);
      if (record && record.bitmap === bitmap) record.characterFrame = frame;
    } };
})();
