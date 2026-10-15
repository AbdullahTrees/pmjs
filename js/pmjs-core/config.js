globalThis.PMJS = globalThis.PMJS || {};
PMJS.config = globalThis.PMJS_GAME_CONFIG || {};

(function() {
  var steam = Object.assign({}, PMJS.config.steam);
  if (steam.provider === undefined) {
    steam.provider = typeof NativeHost !== 'undefined' && NativeHost.greenworks ? 'greenworks' : 'portable';
  }
  PMJS.config.steam = steam;
})();
