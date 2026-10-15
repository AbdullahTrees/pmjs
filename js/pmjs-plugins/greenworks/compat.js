'use strict';
(function() {
  var noop = function() {};
  var steam = PMJS.config.steam || {};
  if (steam.provider !== 'portable' && steam.provider !== 'greenworks') return;
  var names = ['greenworks', 'greenworks.js', './greenworks', './greenworks.js',
    './js/libs/greenworks', './js/libs/greenworks.js',
    './greenworks/greenworks', './greenworks/greenworks.js'];
  ['osx', 'win32', 'win64', 'linux32', 'linux64'].forEach(function(platform) {
    ['./lib/', './js/libs/lib/', './greenworks/lib/'].forEach(function(directory) {
      ['.js', '.node', ''].forEach(function(extension) { names.push(directory + 'greenworks-' + platform + extension); });
    });
  });
  if (steam.provider === 'greenworks') {
    if (!NativeHost.greenworks) {
      throw new Error('Greenworks provider requires --greenworks-module with a compatible host backend');
    }
    registerCommonJsModule(names, NativeHost.greenworks);
    return;
  }
  var backend = pmjsSteam;
  function call(operation, success, failure, resultArguments) {
    return backend.call(operation, success, failure, resultArguments).ok;
  }
  function valueArgument(value) { return [value]; }
  function networkFailure(success, failure) {
    return call(function() { throw backend.unavailable('Online services'); }, success, failure);
  }
  var compat = backend.events;
  Object.assign(compat, {
    init: backend.initialize,
    initAPI: function() {
      try { return backend.initialize(); }
      catch (error) { console.error('[pmjs] local Steam initialization failed:', error); return false; }
    },
    isSteamRunning: function() { return true; },
    restartAppIfNecessary: function() { return false; },
    getAppId: function() { return steam.appId || 0; },
    getSteamId: backend.steamId,
    getCurrentUILanguage: function() { return steam.language || 'english'; },
    getCurrentGameLanguage: function() { return steam.language || 'english'; },
    getNumberOfAchievements: function() { return pmjsAchievements.names().length; },
    getAchievementNames: function() { return pmjsAchievements.names(); },
    getAchievement: function(id, success, failure) {
      var result = backend.call(function() { return pmjsAchievements.isUnlocked(id); },
        success, failure, valueArgument);
      return result.ok ? result.value : false;
    },
    activateAchievement: function(id, success, failure) {
      return call(function() { pmjsAchievements.setUnlocked(id, true); }, success, failure);
    },
    clearAchievement: function(id, success, failure) {
      return call(function() { pmjsAchievements.setUnlocked(id, false); }, success, failure);
    },
    getStatInt: function(name) { return Math.trunc(pmjsAchievements.getStat(name)); },
    getStatFloat: function(name) { return pmjsAchievements.getStat(name); },
    setStat: function(name, value) { return call(function() { pmjsAchievements.setStat(name, value); }); },
    resetAllStats: function(withAchievements) { return pmjsAchievements.resetStats(withAchievements); },
    storeStats: function(success, failure) {
      return call(function() { pmjsAchievements.flush(); }, success, failure);
    },
    indicateAchievementProgress: function(id, current, maximum) {
      if (typeof id !== 'string' || !id || !Number.isFinite(current) || !Number.isFinite(maximum) ||
          current < 0 || maximum <= 0 || current > maximum) return false;
      backend.complete(function() { compat.emit('achievement-progress', id, current, maximum); }, []);
      return true;
    },
    activateGameOverlay: noop, isGameOverlayEnabled: function() { return false; },
    activateGameOverlayToWebPage: function(url) { return openNativeExternal(url); },
    isSubscribedApp: function() { return false; },
    getDLCCount: function() { return 0; }, isDLCInstalled: function() { return false; },
    installDLC: noop, uninstallDLC: noop,
    isCloudEnabled: backend.cloud.enabled, isCloudEnabledForUser: backend.cloud.accountEnabled,
    enableCloud: backend.cloud.enable,
    saveTextToFile: function(name, contents, success, failure) {
      return call(function() { backend.cloud.write(name, contents); }, success, failure);
    },
    readTextFromFile: function(name, success, failure) {
      return call(function() { return backend.cloud.read(name); }, success, failure, valueArgument);
    },
    deleteFile: function(name, success, failure) {
      return call(function() { backend.cloud.remove(name); }, success, failure);
    },
    getFileCount: function() { return backend.cloud.files().length; },
    getFileNameAndSize: function(index) { return backend.cloud.files()[index]; },
    getCloudQuota: function(success, failure) {
      return call(backend.cloud.quota, success, failure, function(result) { return result; });
    },
    getNumberOfPlayers: networkFailure,
    getFriendCount: function() { return 0; }, getFriends: function() { return []; },
    isLoggedOn: function() { return false; },
    FriendFlags: { None: 0, Immediate: 4, All: 511 }
  });
  registerCommonJsModule(names, compat);
})();
