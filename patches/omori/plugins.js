;(function() {
  function decryptIdentity() {
    return function(contents) { return contents; };
  }

  PMJS.plugins.onLoaded('GTP_CoreUpdates', 'port.omori.decrypt', function() {
    if (globalThis.Encryption) Encryption.decrypt = decryptIdentity();
  });

  PMJS.plugins.onLoaded('Aries001_AnimationScreenEffects',
    'port.omori.screen-effects-option', function() {
      PMJS.phases.on('afterGuestPlugins', 'port.omori.screen-effects-option',
        function() {
          var spriteset = globalThis.Spriteset_Base && Spriteset_Base.prototype;
          if (!spriteset) return;
          var createFilters = spriteset.createScreenEffectFilters;
          var update = spriteset.update;
          if (typeof createFilters !== 'function' || typeof update !== 'function') return;
          var filterNames = [
            '_ase_blur_filter', '_ase_zblur_filter', '_ase_glow_filter',
            '_ase_wave_filter', '_ase_dist_filter'
          ];
          function disableScreenEffects(target) {
            for (var index = 0; index < filterNames.length; index++) {
              var filter = target[filterNames[index]];
              if (filter) filter.enabled = false;
            }
          }
          spriteset.createScreenEffectFilters = function() {
            var result = createFilters.apply(this, arguments);
            if (!ConfigManager.screenEffectsEnabled) disableScreenEffects(this);
            return result;
          };
          spriteset.update = function() {
            var result = update.apply(this, arguments);
            if (!ConfigManager.screenEffectsEnabled) disableScreenEffects(this);
            return result;
          };
        });
    });

  PMJS.methods.own({
    key: 'Encryption.decrypt',
    id: 'port.omori.decrypt',
    getTarget: function() { return globalThis.Encryption || null; },
    method: 'decrypt',
    replace: decryptIdentity
  });
})();
