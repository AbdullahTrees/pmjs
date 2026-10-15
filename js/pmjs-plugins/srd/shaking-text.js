'use strict';

(function() {
  var id = 'plugins.srd.shaking-text-disposal';
  PMJS.plugins.registerOptimization('SRD_ShakingText', {
    id: id, owner: 'pmjs-plugins/srd', fallback: 'authored glyph removal and finalization'
  });

  function matches(fn, expected) {
    if (typeof fn !== 'function') return false;
    var source = Function.prototype.toString.call(fn);
    var body = source.slice(source.indexOf('{') + 1, source.lastIndexOf('}')).replace(/\s+/g, '');
    return __pmjsBuiltinRequire('crypto').createHash('sha256').update(body).digest('hex') === expected;
  }

  PMJS.plugins.onLoaded('SRD_ShakingText', 'pmjs.adapter.srd-shaking-text', function() {
    PMJS.phases.on('afterGuestPlugins', 'pmjs.adapter.srd-shaking-text', function() {
      if (!PMJS.optimizations.isEnabled(id)) return;
      var prototype = typeof Window_Message !== 'undefined' && Window_Message.prototype;
      var create = prototype && prototype.createShakingCharacter;
      var remove = prototype && prototype.removeShakingSprites;
      var expectedCreate = 'eea3a24a0548d6685df41899917ec89ace2c758e4e47ca5e2d03931aa06055ef';
      var expectedRemove = '4afd4d215da6f2aa4a4bbbcd170a81f3cd42da2d02d34ad59c6fd4f8c6c7e0fc';
      if (!matches(create, expectedCreate) || !matches(remove, expectedRemove)) {
        PMJS.optimizations.refuse(id, 'unrecognized shaking glyph creation or page removal');
        return;
      }

      // The reviewed producer allocates private glyph resources; only its explicit
      // page removal ends their ownership. Closing or detaching a window does not.
      var owners = new WeakMap();
      function resources(sprite) {
        var bitmap = sprite && sprite.bitmap, texture = sprite && sprite.texture;
        var base = texture && texture.baseTexture, canvas = bitmap && bitmap.__canvas;
        return [bitmap, texture, base, canvas];
      }
      function resourceUses(sprites) {
        var uses = new Map();
        // Unknown/replaced entries can alias a known glyph's resources.
        sprites.forEach(function(sprite) {
          new Set(resources(sprite).filter(Boolean)).forEach(function(value) {
            uses.set(value, (uses.get(value) || 0) + 1);
          });
        });
        return uses;
      }
      function retained() {
        PMJS.compat.observed('plugins.srd.shaking-text-retained', 'modified or shared glyph ownership');
      }

      function createGlyph() {
        var sprites = this._shakingSprites, count = sprites && sprites.length;
        var result = create.apply(this, arguments);
        if (this.createShakingCharacter !== createGlyph || this.removeShakingSprites !== removeGlyphs ||
            this._shakingSprites !== sprites || sprites.length !== count + 1) return result;
        var sprite = sprites[count], values = resources(sprite);
        if (sprite.parent !== this || !values.every(Boolean) ||
            values[0].__baseTexture !== values[2] || values[2].source !== values[3] ||
            typeof values[3]._releaseNativeCanvas !== 'function') return result;
        var owned = owners.get(this);
        if (!owned) owners.set(this, owned = new WeakMap());
        owned.set(sprite, { values: values, destroy: sprite.destroy });
        return result;
      }

      function removeGlyphs() {
        if (this.createShakingCharacter !== createGlyph || this.removeShakingSprites !== removeGlyphs) {
          return remove.apply(this, arguments);
        }
        var sprites = this._shakingSprites.slice(), owned = owners.get(this), uses = resourceUses(sprites);
        var eligible = sprites.filter(function(sprite) {
          var record = owned && owned.get(sprite), values = resources(sprite);
          if (!record) return false;
          var privateGlyph = sprite.parent === this && sprite.destroy === record.destroy &&
            typeof record.destroy === 'function' && !sprite.children.length &&
            values.every(function(value, index) { return value === record.values[index] && uses.get(value) === 1; }) &&
            values[0].__baseTexture === values[2] && values[2].source === values[3];
          if (!privateGlyph) retained();
          return privateGlyph;
        }, this);
        var result = remove.apply(this, arguments);
        // Removal hooks can introduce aliases between previously private glyphs.
        uses = resourceUses(sprites.concat(this._shakingSprites));
        eligible.forEach(function(sprite) {
          var record = owned.get(sprite);
          owned.delete(sprite);
          // A custom removal hook may transfer a glyph instead of retiring it.
          if (sprite.parent || this._shakingSprites.indexOf(sprite) !== -1 ||
              sprite.destroy !== record.destroy || sprite.children.length ||
              record.values[0].__baseTexture !== record.values[2] || record.values[2].source !== record.values[3] ||
              !resources(sprite).every(function(value, index) {
                return value === record.values[index] && uses.get(value) === 1;
              })) return retained();
          sprite.destroy({ texture: true, baseTexture: true });
          record.values[3]._releaseNativeCanvas();
        }, this);
        sprites.forEach(function(sprite) { if (owned) owned.delete(sprite); });
        return result;
      }
      prototype.createShakingCharacter = createGlyph;
      prototype.removeShakingSprites = removeGlyphs;
    });
  });
})();
