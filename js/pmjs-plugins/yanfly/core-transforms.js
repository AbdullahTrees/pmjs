'use strict';

PMJS.phases.on('afterGuestPlugins', 'pmjs.plugins.yanfly.core-transforms', function() {
  if (!globalThis.Yanfly || !Yanfly.Core || typeof Sprite !== 'function') return;
  var predecessor = Yanfly.Core.Sprite_updateTransform;
  var method = Sprite.prototype.updateTransform;
  // Reviewed YEP_CoreEngine 1.31 wrapper.
  var reviewed = ['d90e88e49d2aec7e15ec31fb2d95c0ae9200a283cdc7a63c66c386dda12a064e',
    '866ba21d861bf698e1a5ef3d034a58f8453b55fe618be6596beb29cd6b473429'];
  if (!PMJS.methods.matchesSource(method, reviewed)) return;
  pmjsPixiRenderPreflight.registerTransformEquivalent(method, predecessor, function(node) {
    node.worldTransform.tx = Math.floor(node.worldTransform.tx);
    node.worldTransform.ty = Math.floor(node.worldTransform.ty);
  }, function() { return Yanfly.Core.Sprite_updateTransform === predecessor; }, true);
});
