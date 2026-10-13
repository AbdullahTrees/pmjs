function inspectPluginCompatibility() {
  if (!PMJS.compat.audit) return;
  var expected = {
    Bitmap: ['getPixel', 'getAlphaPixel', 'adjustTone', 'rotateHue', 'blur', 'snap'],
    Graphics: ['isWebGL', 'canUseSaturationBlend', 'isFontLoaded'],
    Input: ['update', 'isPressed', 'isTriggered', 'isRepeated', 'isLongPressed'],
    TouchInput: ['update', 'isPressed', 'isTriggered', 'isCancelled'],
    ImageCache: ['releaseItem', '_truncateCache'],
    Tilemap: ['_compareChildOrder', '_sortChildren', 'update'],
    Sprite_Character: ['update', 'updatePosition', 'updateBitmap', 'updateFrame'],
    Window_Base: ['update', 'convertEscapeCharacters', 'drawTextEx'],
    SceneManager: ['update', 'renderScene', 'isCurrentSceneStarted']
  };
  var expectedProperties = { Bitmap: ['paintOpacity'] };
  Object.keys(expected).forEach(function(className) {
    var constructor = globalThis[className];
    if (!constructor) {
      PMJS.compat.hit('compat.missingClass', className);
      return;
    }
    var prototype = constructor.prototype || constructor;
    expected[className].forEach(function(method) {
      if (typeof prototype[method] !== 'function' &&
          typeof constructor[method] !== 'function') {
        PMJS.compat.hit('compat.missingMethod', className + '.' + method);
      }
    });
    (expectedProperties[className] || []).forEach(function(property) {
      var owner = prototype;
      var descriptor = null;
      while (owner && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(owner, property);
        owner = Object.getPrototypeOf(owner);
      }
      if (!descriptor && !(property in prototype) && !(property in constructor)) {
        PMJS.compat.hit('compat.missingProperty', className + '.' + property);
      }
    });
  });
}
PMJS.phases.on('afterPlugins', 'pmjs-mv.diagnostics', inspectPluginCompatibility);

(function() {
  var thresholdMs = 100;
  var repeatIntervalMs = 5000;
  var active = null;
  var mapBatch = null;
  var lastWarning = new WeakMap();

  function ownValue(object, name) {
    var descriptor = object && Object.getOwnPropertyDescriptor(object, name);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  function commonEventId(list) {
    var events = globalThis.$dataCommonEvents;
    if (!Array.isArray(events)) return 0;
    for (var index = 1; index < events.length; index++) {
      var event = ownValue(events, String(index));
      if (ownValue(event, 'list') === list) return index;
    }
    return 0;
  }
  function report(stall, endedAt) {
    var hot = stall.hot;
    if (!hot) return;
    var previous = lastWarning.get(hot.interpreter);
    if (previous && previous.list === hot.list && endedAt - previous.at < repeatIntervalMs) return;
    lastWarning.set(hot.interpreter, { list: hot.list, at: endedAt });
    console.warn('[pmjs-mv] event-stall ' + JSON.stringify({
      map: ownValue(globalThis.$gameMap, '_mapId') || hot.map,
      event: hot.event, common: commonEventId(hot.list),
      index: hot.index, nextIndex: ownValue(hot.interpreter, '_index'),
      command: ownValue(ownValue(hot.list, String(hot.index)), 'code'),
      freezeChecks: stall.freezeChecks,
      elapsedMs: stall.eventMs, wallMs: endedAt - stall.startedAt, ownMs: hot.ownMs, depth: hot.depth
    }));
  }

  PMJS.methods.wrap({
    key: 'Game_Map.update',
    id: 'pmjs.mv.map-event-stall-diagnostics',
    getTarget: function() { return typeof Game_Map === 'function' ? Game_Map.prototype : null; },
    method: 'update',
    wrap: function(guestUpdate) {
      return function() {
        if (mapBatch) return guestUpdate.apply(this, arguments);
        var batch = { startedAt: performance.now(), eventMs: 0, freezeChecks: 0, hot: null };
        mapBatch = batch;
        try { return guestUpdate.apply(this, arguments); }
        finally {
          mapBatch = null;
          try { if (batch.eventMs >= thresholdMs) report(batch, performance.now()); } catch (_) {}
        }
      };
    }
  });

  PMJS.methods.wrap({
    key: 'Game_Interpreter.update',
    id: 'pmjs.mv.event-stall-diagnostics',
    getTarget: function() { return Game_Interpreter.prototype; },
    method: 'update',
    wrap: function(guestUpdate) {
      return function() {
        var parent = active;
        var startedAt = performance.now();
        var span = { interpreter: this, list: ownValue(this, '_list'),
          map: ownValue(this, '_mapId'), event: ownValue(this, '_eventId'),
          index: ownValue(this, '_index'), startedAt: startedAt, childMs: 0,
          depth: parent ? parent.depth + 1 : 0,
          stall: parent ? parent.stall : mapBatch || { startedAt: startedAt, eventMs: 0, freezeChecks: 0, hot: null } };
        var beforeChecks = ownValue(this, '_frameCount') === Graphics.frameCount
          ? ownValue(this, '_freezeChecker') || 0 : 0;
        active = span;
        try {
          return guestUpdate.apply(this, arguments);
        } finally {
          active = parent;
          // Reporting never supplies a yield or replaces a guest return/exception.
          try {
            var endedAt = performance.now();
            var elapsedMs = endedAt - startedAt;
            span.ownMs = Math.max(0, elapsedMs - span.childMs);
            span.stall.freezeChecks += Math.max(0, (ownValue(this, '_freezeChecker') || 0) - beforeChecks);
            if (!span.stall.hot || span.ownMs > span.stall.hot.ownMs) span.stall.hot = span;
            if (parent) parent.childMs += elapsedMs;
            else {
              span.stall.eventMs += elapsedMs;
              if (!mapBatch && span.stall.eventMs >= thresholdMs) report(span.stall, endedAt);
            }
          } catch (_) {}
        }
      };
    }
  });
})();
