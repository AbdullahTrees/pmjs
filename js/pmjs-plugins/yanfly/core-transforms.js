'use strict';

PMJS.phases.on('afterGuestPlugins', 'pmjs.plugins.yanfly.core-transforms', function() {
  if (!globalThis.Yanfly || !Yanfly.Core || typeof Sprite !== 'function') return;
  var predecessor = Yanfly.Core.Sprite_updateTransform;
  var method = Sprite.prototype.updateTransform;
  var reviewed = function() {
    Yanfly.Core.Sprite_updateTransform.call(this);
    this.worldTransform.tx = Math.floor(this.worldTransform.tx);
    this.worldTransform.ty = Math.floor(this.worldTransform.ty);
  };
  function source(fn) { return Function.prototype.toString.call(fn).replace(/\s/g, ''); }
  if (typeof method !== 'function' || source(method) !== source(reviewed)) return;
  pmjsPixiRenderPreflight.registerTransformEquivalent(method, predecessor, function(node) {
    node.worldTransform.tx = Math.floor(node.worldTransform.tx);
    node.worldTransform.ty = Math.floor(node.worldTransform.ty);
  }, function() { return Yanfly.Core.Sprite_updateTransform === predecessor; }, true);
});
