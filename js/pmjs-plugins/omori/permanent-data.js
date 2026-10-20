'use strict';

// OMORI's GTP_OmoriFixes plugin (Gamefall's Permanent_Manager) remembers which cutscenes may be
// skipped in %LOCALAPPDATA%/OMORI/CUTSCENE.json. While the plugin loads it calls
// fs.readFile(folder + 'CUTSCENE.json', (err, data) => { if (!!err) { throw new Error(err) } ... }).
// The file is only written after the first skippable cutscene, so every new installation throws
// from that callback on each launch until then. Under NW.js the throw is a Node uncaught exception:
// it is logged, window.onerror is not involved, and the game keeps running with no cutscene
// history. Callbacks registered while this plugin loads get those semantics; PMJS keeps treating
// other filesystem callback failures as fatal.
(function() {
  function nwjsUncaught(callback) {
    return function() {
      try { return callback.apply(this, arguments); }
      catch (error) { console.error('[pmjs] uncaught exception in GTP_OmoriFixes fs callback:', error); }
    };
  }

  PMJS.phases.on('beforePlugins', 'pmjs.omori.permanent-data', function() {
    var load = PluginManager.loadScript;
    PluginManager.loadScript = function(name) {
      if (String(name).replace(/\.js$/i, '').toLowerCase() !== 'gtp_omorifixes') {
        return load.apply(this, arguments);
      }
      var fs = require('fs');
      var readFile = fs.readFile;
      fs.readFile = function() {
        var args = Array.prototype.slice.call(arguments);
        var last = args.length - 1;
        if (typeof args[last] === 'function') args[last] = nwjsUncaught(args[last]);
        return readFile.apply(this, args);
      };
      try { return load.apply(this, arguments); }
      finally { fs.readFile = readFile; }
    };
  });
})();
