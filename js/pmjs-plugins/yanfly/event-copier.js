'use strict';

PMJS.plugins.onLoaded('YEP_EventCopier', 'pmjs.adapter.event-copier', function() {
  PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.event-copier', function() {
    var isMapLoaded = DataManager.isMapLoaded;
    DataManager.isMapLoaded = function() {
      // Event initialization never retries a copy whose template is still loading.
      if (!isMapLoaded.apply(this, arguments)) return false;
      return Object.keys(Yanfly.PreloadedMaps).every(function(id) {
        return !!Yanfly.PreloadedMaps[id];
      });
    };
  });
});
