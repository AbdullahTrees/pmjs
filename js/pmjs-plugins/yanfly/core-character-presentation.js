'use strict';

PMJS.phases.on('afterGuestPlugins', 'pmjs.plugins.yanfly.core-character-presentation', function() {
  var presentation = PMJS.mv && PMJS.mv.characterPresentation;
  if (!presentation || !globalThis.Yanfly || !Yanfly.Core ||
      typeof Sprite_Character !== 'function') return;
  var method = Sprite_Character.prototype.updateHalfBodySprites;
  var predecessor = Yanfly.Core.Sprite_Character_updateHalfBodySprites;
  if (typeof method !== 'function') return;
  var source = Function.prototype.toString.call(method).replace(/\s/g, '');
  var digest = __pmjsBuiltinRequire('crypto').createHash('sha256').update(source).digest('hex');
  if (digest !== 'e552fd05edff096b4868f5e1d6b05076d947dba3e2ab07b5a753d4010b45fa0b') return;
  // Yanfly changes the bush sprites, not the main character frame.
  presentation.registerHalfBodyEquivalent(method, predecessor, function() {
    return Yanfly.Core.Sprite_Character_updateHalfBodySprites === predecessor;
  });
});
