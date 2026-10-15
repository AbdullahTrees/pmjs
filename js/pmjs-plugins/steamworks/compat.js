'use strict';
(function() {
  var steam = PMJS.config.steam || {};
  if (steam.provider !== 'portable') return;
  function createClient(appId) {
    var effectiveAppId = appId || steam.appId || 0;
    return {
      cloud: {
        isEnabledForAccount: pmjsSteam.cloud.accountEnabled,
        isEnabledForApp: pmjsSteam.cloud.enabled,
        setEnabledForApp: pmjsSteam.cloud.enable,
        readFile: pmjsSteam.cloud.read,
        writeFile: function(name, contents) { pmjsSteam.cloud.write(name, contents); return true; },
        deleteFile: function(name) { pmjsSteam.cloud.remove(name); return true; },
        fileExists: function(name) { return pmjsSteam.cloud.files().some(function(file) { return file.name === name; }); },
        listFiles: function() { return pmjsSteam.cloud.files().map(function(file) {
          return { name: file.name, size: BigInt(file.size) };
        }); }
      },
      achievement: {
        activate: function(id) { pmjsAchievements.setUnlocked(id, true); return true; },
        isActivated: function(id) { return pmjsAchievements.isUnlocked(id); },
        clear: function(id) { pmjsAchievements.setUnlocked(id, false); return true; },
        names: function() { return pmjsAchievements.names(); }
      },
      stats: {
        getFloat: function(name) { return pmjsAchievements.getStat(name); },
        setFloat: function(name, value) { pmjsAchievements.setStat(name, value); return true; },
        getInt: function(name) { return Math.trunc(pmjsAchievements.getStat(name)); },
        setInt: function(name, value) {
          pmjsAchievements.setStat(name, Math.trunc(value));
          return true;
        },
        store: function() { pmjsAchievements.flush(); return true; },
        resetAll: function(withAchievements) { return pmjsAchievements.resetStats(withAchievements); }
      },
      localplayer: {
        getName: function() { return pmjsSteam.profile().screenName; },
        getSteamId: function() {
          var user = pmjsSteam.profile();
          return { steamId64: BigInt(user.steamId), accountId: user.accountId,
            steamId32: 'STEAM_1:' + user.accountId % 2 + ':' + Math.floor(user.accountId / 2) };
        },
        getLevel: function() { return pmjsSteam.profile().level; }
      },
      utils: { getAppId: function() { return effectiveAppId; } }
    };
  }
  var compat = {
    init: function(appId) { pmjsSteam.initialize(); return createClient(appId); },
    restartAppIfNecessary: function() { return false; }, runCallbacks: function() {},
    electronEnableSteamOverlay: function() {}
  };
  registerCommonJsModule('steamworks.js', compat);
})();
