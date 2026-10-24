'use strict';

(function() {
  var CHUNK_BYTES = 4 * 1024 * 1024;
  var MAX_PALETTE = 256;
  var LITTLE_ENDIAN = (function() {
    var probe = new Uint8Array(4);
    probe[0] = 1;
    return new Uint32Array(probe.buffer)[0] === 1;
  })();

  function colorKey(data, offset) {
    if (data[offset + 3] === 0) return -1;
    return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
  }

  function keyString(key) {
    if (key < 0) return '#00000000';
    var red = (key >> 16) & 255;
    var green = (key >> 8) & 255;
    var blue = key & 255;
    return '#' + ('0' + red.toString(16)).slice(-2) +
      ('0' + green.toString(16)).slice(-2) +
      ('0' + blue.toString(16)).slice(-2);
  }

  function bitsFor(count) {
    if (count <= 2) return 1;
    if (count <= 4) return 2;
    if (count <= 16) return 4;
    return 8;
  }

  function writeBits(packed, index, bits, value) {
    if (bits === 8) {
      packed[index] = value;
      return;
    }
    var bit = index * bits;
    var byte = bit >> 3;
    var shift = bit & 7;
    packed[byte] |= (value << shift) & 255;
    if (shift + bits > 8) packed[byte + 1] |= value >> (8 - shift);
  }

  function readBits(packed, index, bits) {
    if (bits === 8) return packed[index];
    var bit = index * bits;
    var byte = bit >> 3;
    var shift = bit & 7;
    var value = packed[byte] >> shift;
    if (shift + bits > 8) value |= packed[byte + 1] << (8 - shift);
    return value & ((1 << bits) - 1);
  }

  function expandToTwoBits(packed, count, total) {
    var expanded = new Uint8Array((total * 2 + 7) >> 3);
    for (var position = count - 1; position >= 0; position--) {
      if (((packed[position >> 3] >> (position & 7)) & 1) !== 0) {
        expanded[position >> 2] |= 1 << ((position & 3) << 1);
      }
    }
    return expanded;
  }

  function packIndices(packed, indices, total, bits) {
    if (bits === 8) {
      packed.set(indices);
      return;
    }
    var full = total - (total % 8);
    var position;
    if (bits === 1) {
      for (position = 0; position < full; position += 8) {
        packed[position >> 3] = indices[position] | (indices[position + 1] << 1) |
          (indices[position + 2] << 2) | (indices[position + 3] << 3) |
          (indices[position + 4] << 4) | (indices[position + 5] << 5) |
          (indices[position + 6] << 6) | (indices[position + 7] << 7);
      }
    } else if (bits === 2) {
      for (position = 0; position < full; position += 4) {
        packed[position >> 2] = indices[position] | (indices[position + 1] << 2) |
          (indices[position + 2] << 4) | (indices[position + 3] << 6);
      }
    } else {
      for (position = 0; position < full; position += 2) {
        packed[position >> 1] = indices[position] | (indices[position + 1] << 4);
      }
    }
    for (position = full; position < total; position++) {
      writeBits(packed, position, bits, indices[position]);
    }
  }

  function finalize(bitmap, width, height, bits, palette, packed) {
    var colors = [];
    palette.forEach(function(index, key) { colors[index] = keyString(key); });
    bitmap._pmjsFelvidekCollisionData = {
      width: width, height: height, bits: bits, palette: colors, packed: packed
    };
    bitmap._pixelData = [];

  }

  var PREPARED_PREFIX = 'felvidek-collision/';
  var SOURCE_FOLDER = 'img/parallaxes/';
  var MASK_MAGIC = [80, 77, 67, 79, 76, 50, 0, 0];
  var MAX_MASK_PIXELS = 33554432;
  var stockSetCollisionMap = null;

  function decodePreparedMask(bytes) {
    if (!bytes || bytes.length < 17) return null;
    for (var i = 0; i < MASK_MAGIC.length; i++) {
      if (bytes[i] !== MASK_MAGIC[i]) return null;
    }
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var width = view.getUint32(8, true), height = view.getUint32(12, true);
    var pixels = width * height;
    if (!width || !height || pixels > MAX_MASK_PIXELS ||
        16 + Math.ceil(pixels / 8) !== bytes.length) return null;
    return { width: width, height: height, bits: bytes.subarray(16) };
  }

  function passableColorsMask(colors) {
    if (!Array.isArray(colors) || colors.length < 2 || colors.length > 4) return 0;
    var mask = 0;
    for (var i = 0; i < colors.length; i++) {
      if (typeof colors[i] !== 'string') return 0;
      var bit;
      switch (colors[i].toLowerCase()) {
        case '#ffffff': bit = 1; break;
        case '#00000000': bit = 2; break;
        case '#00ff00': bit = 4; break;
        case '#0000ff': bit = 8; break;
        default: return 0;
      }
      if (mask & bit) return 0;
      mask |= bit;
    }
    return mask;
  }

  function supportedPassableQuery(colors) {
    var mask = passableColorsMask(colors);
    return mask === 3 || mask === 7 || mask === 15;
  }

  function hasSupportedPassableColors() {
    var movement = globalThis.QMovement;
    var character = globalThis.Game_CharacterBase;
    if (!movement || !character || !character.prototype ||
        typeof character.prototype.passableColors !== 'function') return null;
    if (String(movement.water1 || '').toLowerCase() !== '#00ff00' ||
        String(movement.water2 || '').toLowerCase() !== '#0000ff') return null;
    var expected = [3, 7, 15, 7, 15];
    try {
      for (var level = 0; level < expected.length; level++) {
        var colors = character.prototype.passableColors.call({ _passabilityLevel: level });
        if (passableColorsMask(colors) !== expected[level]) return false;
      }
    } catch (_) {
      return false;
    }
    return true;
  }

  function hasCollisionQueryMethods() {
    var map = globalThis.Game_Map;
    var prototype = map && map.prototype;
    return !!prototype && typeof prototype.collisionMapPass === 'function' &&
      typeof prototype.collisionMapBoxPass === 'function' &&
      typeof prototype.collisionMapCirclePass === 'function';
  }

  function configuredCollisionFolder() {
    if (!globalThis.QPlus || typeof QPlus.getParams !== 'function') return null;
    try {
      var params = QPlus.getParams('<QMCollisionMap>', true);
      var folder = String(params && params.Folder || '').replace(/\\/g, '/');
      folder = folder.replace(/\/+$/, '') + '/';
      return folder.toLowerCase() === SOURCE_FOLDER ? SOURCE_FOLDER : null;
    } catch (_) {
      return null;
    }
  }

  function decodeMaskForSource(source) {
    var artifact = String(source || '').toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(artifact) ||
        !hasSupportedPassableColors() ||
        !(globalThis.NativeHost && NativeHost.assets &&
          typeof NativeHost.assets.portArtifact === 'function')) return null;
    try {
      return decodePreparedMask(NativeHost.assets.portArtifact(PREPARED_PREFIX + artifact));
    } catch (_) {
      return null;
    }
  }

  function collisionBitmap(mask, source) {
    var bitmap = new Bitmap();
    bitmap._pmjsFelvidekCollisionMask = {
      width: mask.width,
      height: mask.height,
      bits: mask.bits,
      source: source
    };
    bitmap.getColor = function(x, y) {
      x = Math.floor(x);
      y = Math.floor(y);
      if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return '#00000000';
      var index = y * mask.width + x;
      return mask.bits[index >> 3] & (1 << (index & 7)) ? '#010101' : '#00000000';
    };
    return bitmap;
  }

  function fallbackCollisionMask(bitmap, ColliderManagerClass) {
    if (!bitmap || !bitmap._pmjsFelvidekCollisionMask || !stockSetCollisionMap) return false;
    try {
      stockSetCollisionMap.call(ColliderManagerClass, bitmap._pmjsFelvidekCollisionMask.source);
    } catch (_) {
      return false;
    }
    var collisionMap = ColliderManagerClass.collisionMap;
    var replacement = collisionMap && collisionMap.bitmap;
    if (!replacement) return false;
    replacement._pmjsFelvidekCollision = true;
    return true;
  }

  function isDebugDisplayEnabled() {
    if (globalThis.Utils && typeof Utils.isOptionValid === 'function' &&
        Utils.isOptionValid('test')) return true;
    return !!(globalThis.$gameTemp && typeof $gameTemp.isPlaytest === 'function' &&
      $gameTemp.isPlaytest());
  }

  function buildCompact(bitmap) {
    return buildCompactFast(bitmap) || buildCompactGeneric(bitmap);
  }

  function buildCompactFast(bitmap) {
    var width = bitmap.width, height = bitmap.height;
    if (!(width > 0) || !(height > 0) || !LITTLE_ENDIAN) return false;
    var context = bitmap._context;
    if (!context || typeof context.getImageData !== 'function') return false;
    var total = width * height;
    var packed, bits = 1;
    try {
      packed = new Uint8Array((total + 7) >> 3);
    } catch (_) {
      return false;
    }
    var palette = new Map();
    var lastKey = null, lastIndex = -1;
    var chunkRows = Math.max(1, Math.min(height,
      Math.floor(CHUNK_BYTES / Math.max(4, width * 4))));
    var position = 0;
    try {
      for (var row = 0; row < height; row += chunkRows) {
        var rows = Math.min(chunkRows, height - row);
        var image = context.getImageData(0, row, width, rows);
        var data = image && image.data;
        if (!data) return false;
        var words = new Uint32Array(data.buffer, data.byteOffset, data.length >>> 2);
        for (var wordIndex = 0; wordIndex < words.length; wordIndex++, position++) {
          var word = words[wordIndex];
          var key = (word >>> 24) === 0 ? -1 :
            ((word & 255) << 16) | (word & 65280) | ((word >>> 16) & 255);
          var index;
          if (key === lastKey) {
            index = lastIndex;
          } else {
            index = palette.get(key);
            if (index === undefined) {
              index = palette.size;
              if (index >= 4) return false;
              palette.set(key, index);
              if (index === 2) {
                packed = expandToTwoBits(packed, position, total);
                bits = 2;
              }
            }
            lastKey = key;
            lastIndex = index;
          }
          if (bits === 1) {
            if (index !== 0) packed[position >> 3] |= 1 << (position & 7);
          } else {
            packed[position >> 2] |= index << ((position & 3) << 1);
          }
        }
      }
    } catch (_) {
      return false;
    }
    finalize(bitmap, width, height, bits, palette, packed);
    return true;
  }

  function buildCompactGeneric(bitmap) {
    var width = bitmap.width, height = bitmap.height;
    if (!(width > 0) || !(height > 0)) return false;
    var context = bitmap._context;
    if (!context || typeof context.getImageData !== 'function') return false;
    var total = width * height;
    var indices;
    try {
      indices = new Uint8Array(total);
    } catch (_) {
      return false;
    }
    var palette = new Map();
    var lastKey = null, lastIndex = -1;
    var chunkRows = Math.max(1, Math.min(height,
      Math.floor(CHUNK_BYTES / Math.max(4, width * 4))));
    try {
      for (var row = 0; row < height; row += chunkRows) {
        var rows = Math.min(chunkRows, height - row);
        var image = context.getImageData(0, row, width, rows);
        var data = image && image.data;
        if (!data) return false;
        var base = row * width;
        for (var offset = 0, pixel = 0; offset < data.length; offset += 4, pixel++) {
          var key = colorKey(data, offset);
          var index;
          if (key === lastKey) {
            index = lastIndex;
          } else {
            index = palette.get(key);
            if (index === undefined) {
              index = palette.size;
              if (index >= MAX_PALETTE) return false;
              palette.set(key, index);
            }
            lastKey = key;
            lastIndex = index;
          }
          indices[base + pixel] = index;
        }
      }
    } catch (_) {
      return false;
    }
    var bits = bitsFor(palette.size);
    var packed;
    try {
      packed = new Uint8Array(Math.ceil(total * bits / 8));
    } catch (_) {
      return false;
    }
    packIndices(packed, indices, total, bits);
    finalize(bitmap, width, height, bits, palette, packed);
    return true;
  }

  function warmCollisionMap(bitmap, ColliderManagerClass) {
    if (!bitmap || !bitmap._pmjsFelvidekCollision ||
        bitmap._pmjsFelvidekCollisionData || bitmap._pmjsFelvidekWarmupPending) return;

    function prepareIfCurrent() {
      bitmap._pmjsFelvidekWarmupPending = false;
      var collisionMap = ColliderManagerClass.collisionMap;
      if (!collisionMap || collisionMap.bitmap !== bitmap || !bitmap.isReady() ||
          bitmap._pmjsFelvidekCollisionData ||
          bitmap._pixelData && bitmap._pixelData.length) return;
      try { bitmap._setPixelData(); } catch (_) {}
    }

    if (bitmap.isReady()) {
      prepareIfCurrent();
    } else if (typeof bitmap.addLoadListener === 'function') {
      bitmap._pmjsFelvidekWarmupPending = true;
      bitmap.addLoadListener(prepareIfCurrent);
    }
  }

  function install() {
    if (globalThis.__pmjsFelvidekCollisionMapInstalled) return true;
    var BitmapClass = globalThis.Bitmap;
    var ColliderManagerClass = globalThis.ColliderManager;
    var SceneMapClass = globalThis.Scene_Map;
    if (!BitmapClass || !BitmapClass.prototype || !ColliderManagerClass) return false;
    var prototype = BitmapClass.prototype;
    if (typeof prototype._setPixelData !== 'function' ||
        typeof prototype.getColor !== 'function' ||
        typeof ColliderManagerClass.setCollisionMap !== 'function') return false;
    var stockSetPixelData = prototype._setPixelData;
    var stockGetColor = prototype.getColor;
    var stockSetDirty = prototype._setDirty;
    stockSetCollisionMap = ColliderManagerClass.setCollisionMap;
    var GameMapClass = globalThis.Game_Map;

    prototype._setPixelData = function() {
      if (!this._pmjsFelvidekCollision) return stockSetPixelData.apply(this, arguments);
      this._pmjsFelvidekCollisionData = null;
      if (buildCompact(this)) return;
      return stockSetPixelData.apply(this, arguments);
    };

    prototype.getColor = function(x, y) {
      if (this._pmjsFelvidekCollision && !this._pmjsFelvidekCollisionData &&
          (!this._pixelData || this._pixelData.length === 0)) {
        this._setPixelData();
      }
      var compact = this._pmjsFelvidekCollisionData;
      if (!compact) return stockGetColor.apply(this, arguments);
      if (this._pixelData && this._pixelData.length !== 0) {
        this._pmjsFelvidekCollisionData = null;
        return stockGetColor.apply(this, arguments);
      }
      if (compact.width !== this.width || compact.height !== this.height) {
        this._pmjsFelvidekCollisionData = null;
        this._pixelData = [];
        return stockGetColor.apply(this, arguments);
      }
      x = Math.floor(x);
      y = Math.floor(y);
      if (x < 0 || y < 0 || x >= compact.width || y >= compact.height) {
        return '#00000000';
      }
      var index = readBits(compact.packed, y * compact.width + x, compact.bits);
      return compact.palette[index] || '#00000000';
    };

    if (typeof stockSetDirty === 'function') {
      prototype._setDirty = function() {
        if (this._pmjsFelvidekCollisionMask) {
          if (fallbackCollisionMask(this, ColliderManagerClass)) {
            this._pmjsFelvidekCollisionMask = null;
          }
        }
        if (this._pmjsFelvidekCollisionData) {
          this._pmjsFelvidekCollisionData = null;
          this._pixelData = [];
        }
        return stockSetDirty.apply(this, arguments);
      };
    }

    ColliderManagerClass.setCollisionMap = function(source) {
      var name = String(source || '').replace(/\.png$/i, '');
      var mask = null;
      if (!isDebugDisplayEnabled() && this.visible !== true &&
          configuredCollisionFolder() === SOURCE_FOLDER &&
          /^[a-z][a-z0-9_-]{0,63}$/i.test(name) && /^colizia/i.test(name) &&
          hasCollisionQueryMethods() &&
          hasSupportedPassableColors()) {
        mask = decodeMaskForSource(name);
      }
      if (mask) {
        var bitmap = collisionBitmap(mask, name.toLowerCase());
        if (bitmap) {
          this.collisionMap.bitmap = bitmap;
          return;
        }
      }

      var result = stockSetCollisionMap.apply(this, arguments);
      var bitmap = ColliderManagerClass.collisionMap &&
        ColliderManagerClass.collisionMap.bitmap;
      if (bitmap) {
        bitmap._pmjsFelvidekCollision = true;
      }
      return result;
    };

    if (GameMapClass && GameMapClass.prototype) {
      ['collisionMapBoxPass', 'collisionMapCirclePass'].forEach(function(method) {
        var stockPass = GameMapClass.prototype[method];
        if (typeof stockPass !== 'function') return;
        GameMapClass.prototype[method] = function(collider, direction, passableColors) {
          var collisionMap = ColliderManagerClass.collisionMap;
          var bitmap = collisionMap && collisionMap.bitmap;
          if (bitmap && bitmap._pmjsFelvidekCollisionMask &&
              !supportedPassableQuery(passableColors)) {
            fallbackCollisionMask(bitmap, ColliderManagerClass);
            return false;
          }
          return stockPass.apply(this, arguments);
        };
      });
    }

    if (typeof ColliderManagerClass.show === 'function') {
      var stockShowCollisionManager = ColliderManagerClass.show;
      ColliderManagerClass.show = function() {
        var collisionMap = this.collisionMap;
        if (collisionMap && collisionMap.bitmap &&
            collisionMap.bitmap._pmjsFelvidekCollisionMask) {
          fallbackCollisionMask(collisionMap.bitmap, ColliderManagerClass);
        }
        return stockShowCollisionManager.apply(this, arguments);
      };
    }

    if (SceneMapClass && SceneMapClass.prototype &&
        typeof SceneMapClass.prototype.onMapLoaded === 'function') {
      var stockOnMapLoaded = SceneMapClass.prototype.onMapLoaded;
      SceneMapClass.prototype.onMapLoaded = function() {
        var result = stockOnMapLoaded.apply(this, arguments);
        var collisionMap = ColliderManagerClass.collisionMap;
        warmCollisionMap(collisionMap && collisionMap.bitmap, ColliderManagerClass);
        return result;
      };
    }

    globalThis.__pmjsFelvidekCollisionMapInstalled = true;
    return true;
  }

  PMJS.phases.on('afterGuestPlugins', 'felvidek.collision-map', install);
})();
