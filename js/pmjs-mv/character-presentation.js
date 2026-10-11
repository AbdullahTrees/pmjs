'use strict';

(function() {
  var presentation = PMJS.pixi4.bitmapPresentation;
  if (!presentation || typeof Sprite_Character !== 'function' ||
      typeof Game_CharacterBase !== 'function') return;
  var spriteHashes = {
    updateCharacterFrame: 'df204cc18118e6f2fda30f909d02b1ac43e161b37178ae17c888891d562f7d8f',
    updateHalfBodySprites: '0dc95c24a4048049298b1e54559c635f82f11eb5ed780d514bfc099fdb823bc2',
    patternWidth: '13e0b1e14099fc5d6678100a59b9d8d23b29f4a42cef09f25061823023846b7f',
    patternHeight: 'ea8a8a66748df6a374eae65149b6269d1db0c567489eb6aaa41dd764bc3ee67d',
    characterBlockX: '69e6eac8a0bf113c16d1ef8149ec4dfa2e37cdda5e915225de234687c6fc54e8',
    characterBlockY: 'cefeada8bcbff467f48b94056bacc93028b9a1095e1cc0a3a9358e85614ff6c0',
    characterPatternX: '5a47f7821e60d92a694a70ee33beb90410a52b6e0d5caf706fb95a5d2780cd17',
    characterPatternY: '834752658fb8f0416bdabaf0eed4717e79b2bdde8470c48cf1dd95bbe8786b13'
  };
  var characterHashes = {
    pattern: 'c02695471190a7154daaab964ab1acb5bf568ce4835de30e3134e3b630c4fa2f',
    direction: '811fbb690e1f5ecd518866a594f39a77fc9e1fc3e52f530108a0fd3dd0deb4e9',
    characterIndex: 'a17e7cf1abb34748fda7a7765a4f75bd42c477ed27315d676716c5ece87b180d'
  };
  function capture(prototype, hashes) {
    var methods = {};
    for (var name of Object.keys(hashes)) {
      var method = prototype[name];
      if (typeof method !== 'function') return null;
      var source = Function.prototype.toString.call(method)
        .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
        .replace(/^function(?:\s+[\w$]+)?\s*\(/, 'function(').replace(/\s/g, '');
      if (__pmjsBuiltinRequire('crypto').createHash('sha256').update(source).digest('hex') !== hashes[name]) return null;
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
    var dimensions = presentation.dimensions(this);
    var character = this._character, bitmap = this.bitmap, frame = null;
    if (dimensions && bitmap && bitmap.width === 0 && bitmap.height === 0 &&
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
