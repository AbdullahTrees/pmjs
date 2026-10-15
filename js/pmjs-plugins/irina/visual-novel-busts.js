'use strict';

PMJS.plugins.onLoaded('Irina_VisualNovelBusts', 'pmjs.adapter.visual-novel-busts', function() {
  var proto = Sprite_VisualNovelBust.prototype;
  var loadBitmap = proto.loadBitmap;
  var guardedHooks = new WeakMap();
  proto.loadBitmap = function(type, name) {
    if (this._type === type && this._bustName === name) {
      return loadBitmap.apply(this, arguments);
    }
    var request = this._pmjsBustRequest = {};
    var afterLoad = this.afterLoadBitmap;
    afterLoad = guardedHooks.get(afterLoad) || afterLoad;
    var descriptor = Object.getOwnPropertyDescriptor(this, 'afterLoadBitmap');
    // The plugin binds this hook while registering the requested bitmap listener.
    var guarded = function() {
      if (this._pmjsBustRequest === request && this._bustName !== '') {
        return afterLoad.apply(this, arguments);
      }
    };
    guardedHooks.set(guarded, afterLoad);
    this.afterLoadBitmap = guarded;
    try { return loadBitmap.apply(this, arguments); }
    finally {
      if (this.afterLoadBitmap === guarded) {
        if (descriptor) Object.defineProperty(this, 'afterLoadBitmap', descriptor);
        else delete this.afterLoadBitmap;
      }
    }
  };
});
