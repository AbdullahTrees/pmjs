'use strict';

PMJS.plugins.onLoaded('OrangeGreenworks', 'pmjs.adapter.orange-greenworks', function() {
  var plugin = Hudell.OrangeGreenworks;
  plugin.storeStats = function() {
    if (!plugin.isSteamRunning()) return false;
    return plugin.greenworks.storeStats(plugin._storeStatsSuccess, plugin._storeStatsError);
  };
});
