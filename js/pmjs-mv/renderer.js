function createNativeMvRenderer() {
    this._renderer = createNativePixiRenderer(this._width, this._height, {
      view: this._canvas,
      resolution: 1,
      autoResize: false
    });
}

function renderNativeMvStage(stage) {
    if (stage) {
      this._renderer.render(stage);
      if (this._renderer.gl && this._renderer.gl.flush) this._renderer.gl.flush();
    }
    this._skipCount = 0;
    this._rendered = true;
    this.frameCount++;
}

Graphics._createRenderer = createNativeMvRenderer;

PMJS.methods.wrap({
  key: 'Graphics._createRenderer',
  getTarget: function() { return Graphics; },
  method: '_createRenderer',
  id: 'pmjs.mv.native-renderer-postcondition',
  wrap: function(guestCreateRenderer) {
    return function() {
      var result = guestCreateRenderer.apply(this, arguments);
      if (!PMJS.pixi4.isNativeRenderer(this._renderer)) {
        throw new Error('Graphics._createRenderer must create a PMJS native renderer');
      }
      return result;
    };
  }
});

PMJS.methods.own({
  key: 'Graphics.render',
  getTarget: function() {
    return (typeof Graphics !== 'undefined') ? Graphics : null;
  },
  method: 'render',
  id: 'pmjs.mv.native-render',
  replace: function() {
    return renderNativeMvStage;
  }
});
var originalIsOptionValid = Utils.isOptionValid;
Utils.isOptionValid = function(name) {
  return (!globalThis.AudioContext && name === 'noaudio') ||
    originalIsOptionValid.call(this, name);
};

if (typeof PMJS !== 'undefined' && PMJS.optimizations &&
    typeof PMJS.optimizations.register === 'function') {
  PMJS.optimizations.register({
    id: 'sprite.native-tint',
    owner: 'pmjs-mv',
    fallback: 'Stock Canvas 2D Sprite._executeTint pixel passes'
  });
  if (PMJS.phases && typeof PMJS.phases.on === 'function') {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.mv.native-sprite-tint-proof', function() {
      var changed = PMJS.methods.dump().some(function(record) {
        return (record.key === 'Sprite._refresh' ||
          record.key === 'Sprite._executeTint' ||
          record.key === 'Sprite._needsTint') && record.mutations.length > 0;
      });
      if (changed) PMJS.optimizations.refuse('sprite.native-tint',
        'guest changed Sprite tint methods');
    });
  }
}

PMJS.methods.wrap({
  key: 'Sprite._executeTint',
  getTarget: function() {
    return (typeof Sprite !== 'undefined' && Sprite.prototype) || null;
  },
  method: '_executeTint',
  id: 'pmjs.mv.native-sprite-tint-execution-proof',
  wrap: function(stockExecuteTint) { return stockExecuteTint; }
});

PMJS.methods.wrap({
  key: 'Sprite._needsTint',
  getTarget: function() {
    return (typeof Sprite !== 'undefined' && Sprite.prototype) || null;
  },
  method: '_needsTint',
  id: 'pmjs.mv.native-sprite-tint-needs-proof',
  wrap: function(stockNeedsTint) { return stockNeedsTint; }
});

PMJS.methods.wrap({
  key: 'Sprite._refresh',
  getTarget: function() {
    return (typeof Sprite !== 'undefined' && Sprite.prototype) ? Sprite.prototype : null;
  },
  method: '_refresh',
  id: 'pmjs.mv.native-sprite-tint',
  wrap: function(stockRefresh) {
    var neutralTone = [0, 0, 0, 0];
    var neutralBlend = [0, 0, 0, 0];
    var nativeRefresh = function() {
      if (this instanceof Sprite &&
          this._refresh === Sprite.prototype._refresh &&
          this._executeTint === Sprite.prototype._executeTint &&
          this._needsTint === Sprite.prototype._needsTint &&
          this._pmjsNativeSpriteTint !== false &&
          PMJS.optimizations.isEnabled('sprite.native-tint')) {
        var tone = this._colorTone;
        var blend = this._blendColor;
        var hasTone = tone && (tone[0] || tone[1] || tone[2] || tone[3]);
        var hasBlend = blend && blend[3] > 0;
        if ((hasTone || hasBlend) &&
            (!hasTone || Object.getPrototypeOf(this) === Sprite.prototype)) {
          this._colorTone = neutralTone;
          this._blendColor = neutralBlend;
          try {
            return stockRefresh.apply(this, arguments);
          } finally {
            this._colorTone = tone;
            this._blendColor = blend;
          }
        }
      }
      return stockRefresh.apply(this, arguments);
    };
    var presentation = PMJS.mv && PMJS.mv.characterPresentation;
    if (presentation) {
      presentation.registerRefreshEquivalent(nativeRefresh, stockRefresh, function() { return true; });
    }
    return nativeRefresh;
  }
});
