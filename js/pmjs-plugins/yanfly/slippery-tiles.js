'use strict';

if (typeof PMJS !== 'undefined' && PMJS.plugins &&
    typeof PMJS.plugins.registerOptimization === 'function') {
  PMJS.plugins.registerOptimization('YEP_SlipperyTiles', {
    id: 'plugins.yanfly.slippery-tiles',
    owner: 'pmjs-plugins/yanfly',
    fallback: 'stock YEP_SlipperyTiles isSlippery check on every call'
  });
}

(function() {

  // MV 1.6.1 membership and YEP_SlipperyTiles 1.05 query.
  var KNOWN_CONTAINS = ['2b4ef5ac511af2a98109ab4d0b75cc66af8e533adf8d852d82f751941a7d68e1',
    '0a14e5f3f0be233bf31d33eeecb6d55d5c34aca2a60a567f65891cbf7dc7e3f5',
    // MV 1.6.1 descriptor-defined contains, original CRLF source.
    '70490d2a5d5d80be4b5a0a8a2861d212f3f99eee98598d360067880050e3e1fa'];
  var KNOWN_SLIPPERY_QUERY = ['a36c9d35d257710fabbc1270f2ab8d0f715a855815b352766d9c2e17aa50c606',
      '425386319071765fdcb4f7874c65eb031dbe13f651098a84b1e1ff633505ccbe'];

  function install() {
    if (!PMJS.optimizations.isEnabled('plugins.yanfly.slippery-tiles')) {
      return false;
    }

    var mapProto = typeof Game_Map !== 'undefined' &&
      Game_Map.prototype ? Game_Map.prototype : null;
    if (!mapProto || typeof mapProto.isSlippery !== 'function') {
      PMJS.optimizations.refuse('plugins.yanfly.slippery-tiles',
        'Yanfly map methods unavailable');
      return false;
    }
    if (mapProto.__pmjsSlipperyTilesGuard) return true;

    if (!PMJS.methods.matchesSource(mapProto.isSlippery, KNOWN_SLIPPERY_QUERY)) {
      PMJS.optimizations.refuse('plugins.yanfly.slippery-tiles',
        'unrecognized Yanfly isSlippery method composition');
      return false;
    }

    var originalIsSlippery = mapProto.isSlippery;
    var stockContains = Array.prototype.contains;
    var nativeIndexOf = Array.prototype.indexOf;
    var knownContains = typeof stockContains === 'function' &&
      PMJS.methods.matchesSource(stockContains, KNOWN_CONTAINS) &&
      /\[native code\]/.test(Function.prototype.toString.call(nativeIndexOf));
    if (!knownContains || typeof Yanfly === 'undefined' || !Yanfly.Param ||
        Yanfly.Param.SlipRegion !== 0) {
      PMJS.optimizations.refuse('plugins.yanfly.slippery-tiles',
        'slippery region or array membership composition requires guest query');
      return false;
    }

    mapProto.isSlippery = function(mx, my) {
      if (Yanfly.Param.SlipRegion === 0 &&
          Array.prototype.contains === stockContains &&
          Array.prototype.indexOf === nativeIndexOf) {
        var tileset = this.tileset();
        var slipTiles = tileset && tileset.slippery;
        if (Array.isArray(slipTiles) && slipTiles.length === 0 &&
            slipTiles.contains === stockContains &&
            slipTiles.indexOf === nativeIndexOf) return false;
        if (Array.isArray(slipTiles) && slipTiles.length === 0) {
          PMJS.optimizations.reportFallback('plugins.yanfly.slippery-tiles',
            'tileset array membership methods changed after installation');
        }
      } else {
        PMJS.optimizations.reportFallback('plugins.yanfly.slippery-tiles',
          'slippery region or array membership methods changed after installation');
      }
      return originalIsSlippery.call(this, mx, my);
    };

    mapProto.isSlippery._pmjsSlipperyTilesGuard = true;
    mapProto.__pmjsSlipperyTilesGuard = true;
    return true;
  }

  PMJS.plugins.onLoaded('YEP_SlipperyTiles',
    'pmjs.adapter.yanfly-slippery-tiles', function() {
      PMJS.phases.on('afterGuestPlugins',
        'pmjs.adapter.yanfly-slippery-tiles', install);
    });
})();
