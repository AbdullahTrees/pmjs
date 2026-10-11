'use strict';

(function() {
  function afterServices() {
    if (typeof SceneManager !== 'undefined' &&
        SceneManager.ticker &&
        SceneManager.ticker._pmjsHostDriven &&
        typeof SceneManager.ticker.update === 'function') {
      SceneManager.ticker.update(performance.now());
    }
  }

  function pmjsMvTick(now) {
    return globalThis.pmjsRunRpgMakerTick(now, afterServices);
  }

  function pmjsMvRender(now) {
    if (typeof Graphics !== 'undefined' && Graphics._renderer &&
        typeof Graphics._renderer._pmjsSyncPresentation === 'function') {
      Graphics._renderer._pmjsSyncPresentation();
    }
  }

  globalThis.pmjsMvTick = pmjsMvTick;
  globalThis.pmjsMvRender = pmjsMvRender;
  globalThis.__pmjsTick = pmjsMvTick;
  globalThis.__pmjsRender = pmjsMvRender;
})();
