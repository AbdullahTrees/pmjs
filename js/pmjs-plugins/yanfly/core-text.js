'use strict';

(function() {
  var id = 'plugins.yanfly.core-native-text';
  PMJS.plugins.registerOptimization('YEP_CoreEngine', {
    id: id, owner: 'pmjs-plugins/yanfly', fallback: 'captured MV Canvas text drawing'
  });

  function matches(fn, expected) {
    if (typeof fn !== 'function') return false;
    var source = Function.prototype.toString.call(fn);
    var body = source.slice(source.indexOf('{') + 1, source.lastIndexOf('}')).replace(/\s+/g, '');
    return __pmjsBuiltinRequire('crypto').createHash('sha256').update(body).digest('hex') === expected;
  }

  PMJS.plugins.onLoaded('YEP_CoreEngine', 'pmjs.adapter.yanfly-core-text', function() {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.yanfly-core-text', function() {
      if (!PMJS.optimizations.isEnabled(id)) return;
      var core = globalThis.Yanfly && Yanfly.Core;
      var bitmap = PMJS.mv && PMJS.mv.bitmap;
      var font = typeof Bitmap !== 'undefined' && Bitmap.prototype._makeFontNameText;
      var stockFontHash = '1fcc0dad85172b095c88e8515451f6a2eff889b387a44212f7f56ce5525a6cfe';
      var boldFontHash = '1c9fb0ddce4aafac10f5d1463226f01b6b48244874c9b03ba1f00ffb9b26a73c';
      var fontStillValid;
      if (!matches(font, stockFontHash)) {
        var message = globalThis.Yanfly && Yanfly.Message;
        var predecessor = message && message.Bitmap_makeFontNameText;
        if (!matches(font, boldFontHash) || !matches(predecessor, stockFontHash)) {
          PMJS.optimizations.refuse(id, 'unrecognized Bitmap font method composition');
          return;
        }
        fontStillValid = function() {
          return Yanfly.Message === message && message.Bitmap_makeFontNameText === predecessor;
        };
      }
      var draw = core && bitmap && typeof bitmap.createNativeDrawText === 'function' &&
        bitmap.createNativeDrawText(core.Bitmap_drawText, font, fontStillValid);
      if (typeof draw !== 'function') {
        PMJS.optimizations.refuse(id, 'unrecognized captured Bitmap text drawing contract');
        return;
      }
      // Keep plugin wrappers and their side effects above the captured MV leaf.
      core.Bitmap_drawText = draw;
    });
  });
})();
