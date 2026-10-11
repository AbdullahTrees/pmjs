'use strict';

PMJS.plugins.onLoaded('SRD_MenuBackgrounds', 'pmjs.adapter.srd-menu-backgrounds', function() {
  PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.srd-menu-backgrounds', function() {
    var backgrounds = SRD.MenuBackgrounds;
    var create = Scene_MenuBase.prototype.createBackground;

    Scene_MenuBase.prototype.createBackground = function() {
      var request = this._pmjsMenuBackgroundRequest = {};
      var filename = backgrounds.backgrounds[this._menuBackgroundConstructorName];
      var source = filename ? backgrounds.loadImage(filename) : null;
      var ready = source && source.isReady();
      var result = create.apply(this, arguments);
      if (!source || ready) return result;

      var scene = this;
      var sprite = this._backgroundSprite;
      var destination = sprite.bitmap;
      source.addLoadListener(function() {
        if (!source.isReady() || scene._pmjsMenuBackgroundRequest !== request ||
            scene._backgroundSprite !== sprite || sprite.bitmap !== destination ||
            sprite.parent !== scene) return;
        var width = backgrounds.scale ? Graphics.boxWidth : source.width;
        var height = backgrounds.scale ? Graphics.boxHeight : source.height;
        if (source.width <= 0 || source.height <= 0 || width <= 0 || height <= 0) return;

        var composed = new Bitmap(width, height);
        composed.blt(source, 0, 0, source.width, source.height, 0, 0, width, height);
        sprite.bitmap = composed;
        scene._pmjsMenuBackgroundRequest = null;
      });
      return result;
    };

    function guardTermination(prototype) {
      var terminate = prototype.terminate;
      prototype.terminate = function() {
        // MV can leave children attached to a terminated scene.
        this._pmjsMenuBackgroundRequest = null;
        return terminate.apply(this, arguments);
      };
    }
    guardTermination(Scene_MenuBase.prototype);
    Object.keys(backgrounds.backgrounds).forEach(function(name) {
      var scene = globalThis[name];
      if (backgrounds.backgrounds[name] && scene &&
          scene.prototype instanceof Scene_MenuBase &&
          Object.prototype.hasOwnProperty.call(scene.prototype, 'terminate')) {
        // Plugin overrides can capture the base method before this adapter installs.
        guardTermination(scene.prototype);
      }
    });
  });
});
