'use strict';

PMJS.methods.wrap({
  key: 'Felvidek.DataManager.loadDataFile',
  id: 'pmjs.felvidek.empty-qmap-index',
  getTarget: function() { return globalThis.DataManager; },
  method: 'loadDataFile',
  wrap: function(load) {
    return function(name, source) {
      if (source === 'QMap.json') {
        var fs = require('fs');
        var path = '/game/data/QMap.json';
        if (fs.existsSync(path) && fs.readFileSync(path).length === 0) {
          // Version-two QMap indexes begin with "2"; an empty index has no map entries.
          globalThis[name] = null;
          PMJS.tasks.enqueue(function() {
            globalThis[name] = ['2'];
            DataManager.onLoad(globalThis[name]);
          });
          return;
        }
      }
      return load.apply(this, arguments);
    };
  }
});
