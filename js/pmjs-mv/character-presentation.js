'use strict';

(function() {
  var presentation = PMJS.pixi4.bitmapPresentation;
  if (!presentation || typeof Sprite_Character !== 'function' ||
      typeof Game_CharacterBase !== 'function') return;
  // Reviewed MV 1.6.1 character methods; LF and CRLF sources are pinned separately.
  var spriteHashes = {
    updateCharacterFrame: ['2ccc735d0d8541e3f0a420b675813ed1629321d7f4c03ea849552925e650c603',
      '719880bcf767f19364aec2737025ca9cd316c19a955c4e314f4c8542b7019e8d'],
    updateHalfBodySprites: ['95c92ec4fa2605e8bc399ce9f0fa0a200439ca359a78519c51005765085e1d0e',
      '47092631641a26aa9d3d7e9f80e1840b8f0fb9e12e6b2a3a454cb3788a16ff78'],
    patternWidth: ['5f3cb794865aac364d7cee5fbac4863a697d25726bf6a206e64617cf9cd5117f',
      '46d44179ca8be450446e5486f0833d96341cccf2818bc772256de52f0ab5e3f6'],
    patternHeight: ['a94b05d2ed243b5d3c9b43a943189031b9d8e44c213387763ca2c6c1a4b666aa',
      '6bcbe7b8a62bed13e40f7f299222c571593ee561cc9d1b6e484d0a006318d7d3'],
    characterBlockX: ['158ac695da20083005640302b05993da70a2944c300e75dd4a97b1928c3279d3',
      '76d7c5af3b172bb03cb15aedf693673a32e4760c0c7a95a79bc420a5983317d1'],
    characterBlockY: ['5bed082d897d3a62d240bd69feec4ad07fc646f34b3bae293f052dc2ae4a22ea',
      '20953a88f0212e8821f2ed3cc0e3557ecf2988c1082a7c3dbc6444f89cea6de6'],
    characterPatternX: ['6ee10e0e7092d5ff94aee9fc48547e4db540d203b77323ac0b72e05c663bcd85',
      'd8367f4faa2dd88f43d512d35c9c2af9873798f219bac91f4589c9d88f1c6b95'],
    characterPatternY: ['a7ed9a0d788a33e97d393a3bd27063161dee09b47903562fe7a6c28d1d4a6919',
      'd82f8f1ef9c986740a1d6e0aed4c655f17a2847ddfe3305a5737859694d8c59d']
  };
  var characterHashes = {
    pattern: ['7df74689d1722e740b2736021d482d071698fc62564bc3af7a38551425262a80',
      'f448c2f4006cf1441205392c63fe405784c375bd947ae83f444e78c285f87910'],
    direction: ['3383eebbc27e6f811e2e816e9db1a3e2dc79f048008913f0df4b48473948e2b2',
      'ff6d019794c6df7de9b2ac7d43dc5cfa37bbcbb9c61d8ff3cb4d5ec8e5364761'],
    characterIndex: ['c4e0e5d020900cd81cda0b58155a704eb17c6877c43fc3329f6a3e0c533c82c6',
      '59542fc4ef3e8f9c26e2fd4f04fc80754eb47ceafd6a77c604618db069d4f915']
  };
  function capture(prototype, hashes) {
    var methods = {};
    for (var name of Object.keys(hashes)) {
      var method = prototype[name];
      if (typeof method !== 'function') return null;
      if (!PMJS.methods.matchesSource(method, hashes[name])) return null;
      methods[name] = method;
    }
    return methods;
  }
  var spriteMethods = capture(Sprite_Character.prototype, spriteHashes);
  var characterMethods = capture(Game_CharacterBase.prototype, characterHashes);
  if (!spriteMethods || !characterMethods) return;
  var frameSetter = Sprite.prototype.setFrame;
  var frameRefresh = Sprite.prototype._refresh;
  var halfBodyMethods = new Map([[spriteMethods.updateHalfBodySprites, function() { return true; }]]);
  var refreshMethods = new Map([[frameRefresh, function() { return true; }]]);
  function register(methods, method, predecessor, verify) {
    if (typeof method !== 'function' || typeof verify !== 'function' ||
        methods.has(method) || !methods.has(predecessor)) return false;
    var predecessorCheck = methods.get(predecessor);
    methods.set(method, function() { return predecessorCheck() && verify(); });
    return true;
  }
  PMJS.mv = PMJS.mv || {};
  PMJS.mv.characterPresentation = {
    registerHalfBodyEquivalent: function(method, predecessor, verify) {
      return register(halfBodyMethods, method, predecessor, verify);
    },
    registerRefreshEquivalent: function(method, predecessor, verify) {
      return register(refreshMethods, method, predecessor, verify);
    }
  };
  function unchanged(object, methods, exclude) {
    return Object.keys(methods).every(function(name) {
      return exclude.includes(name) || object[name] === methods[name];
    });
  }
  function field(object, name) {
    var descriptor = Object.getOwnPropertyDescriptor(object, name);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  }
  Sprite_Character.prototype.updateCharacterFrame = function() {
    var character = this._character, bitmap = this.bitmap, frame = null;
    var dimensions = bitmap && bitmap.width === 0 && bitmap.height === 0 && presentation.dimensions(this);
    if (dimensions &&
        field(this, '_tileId') === 0 && field(this, '_bushDepth') === 0 &&
        typeof field(this, '_isBigCharacter') === 'boolean' && this.setFrame === frameSetter &&
        refreshMethods.has(this._refresh) && refreshMethods.get(this._refresh)() &&
        character && unchanged(this, spriteMethods, ['updateCharacterFrame', 'updateHalfBodySprites']) &&
        halfBodyMethods.has(this.updateHalfBodySprites) && halfBodyMethods.get(this.updateHalfBodySprites)() &&
        unchanged(character, characterMethods, [])) {
      var pattern = field(character, '_pattern'), direction = field(character, '_direction');
      var index = field(character, '_characterIndex');
      if (Number.isInteger(pattern) && Number.isInteger(index) && index >= 0 &&
          [2, 4, 6, 8].includes(direction)) {
        var big = this._isBigCharacter;
        var width = dimensions.width / (big ? 3 : 12);
        var height = dimensions.height / (big ? 4 : 8);
        frame = { x: ((big ? 0 : index % 4 * 3) + (pattern < 3 ? pattern : 1)) * width,
          y: ((big ? 0 : Math.floor(index / 4) * 4) + (direction - 2) / 2) * height,
          width: width, height: height };
      }
    }
    spriteMethods.updateCharacterFrame.apply(this, arguments);
    // Keep the original frame unchanged; this only affects native drawing.
    var requested = this._frame;
    if (frame && requested.x === 0 && requested.y === 0 &&
        requested.width === 0 && requested.height === 0) {
      presentation.setCharacterFrame(this, bitmap, frame);
    }
  };
})();
