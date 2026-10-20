'use strict';

(function() {

  function updateNativeServices() {
    if (globalThis.PMJS && PMJS.rpgmaker && PMJS.rpgmaker.audio &&
        typeof PMJS.rpgmaker.audio.update === 'function') {
      PMJS.rpgmaker.audio.update();
    }
    if (globalThis.PMJS && PMJS.web && PMJS.web.video) {
      PMJS.web.video.update();
    }
  }

  function runTick(now, afterServices, beforeScheduler) {
    updateNativeServices();
    return PMJS.tasks.invokeRendering(function() {
      if (typeof afterServices === 'function') afterServices(now);
    }).then(function() {
      if (typeof beforeScheduler === 'function') beforeScheduler(now);
      return globalThis.pmjsDrainScheduler(now);
    });
  }

  globalThis.pmjsRunRpgMakerTick = runTick;
})();
