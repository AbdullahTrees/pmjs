'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const zlib = require('node:zlib');

const preparer = require('../../../patches/felvidek/collision-map.pmjs-processor.cjs');
const adapterFile = path.join(__dirname, '../../../patches/felvidek/collision-map.js');
const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function pngRGBA(width, height, pixels, filters = 0) {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  function chunk(type, data) {
    return makeChunk(type, data);
  }
  const rows = Buffer.alloc((width * 4 + 1) * height);
  let previous = Buffer.alloc(width * 4);
  for (let y = 0; y < height; y++) {
    const filter = Array.isArray(filters) ? filters[y % filters.length] : filters;
    const raw = pixels.subarray(y * width * 4, (y + 1) * width * 4);
    const offset = y * (width * 4 + 1);
    rows[offset] = filter;
    for (let x = 0; x < raw.length; x++) {
      const left = x >= 4 ? raw[x - 4] : 0;
      const up = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upperLeft;
        const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      }
      rows[offset + 1 + x] = (raw[x] - predictor) & 255;
    }
    previous = raw;
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function blockedAt(buf, x, y) {
  const width = buf.readUInt32LE(8);
  const index = y * width + x;
  return (buf[16 + (index >> 3)] & (1 << (index & 7))) !== 0;
}

function enumerateOccupancy(buf, width, height) {
  const result = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) result.push(blockedAt(buf, x, y));
  return result;
}

function reorderChunks(png, order) {
  const chunks = new Map();
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    chunks.set(type, png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return Buffer.concat([png.subarray(0, 8), ...order.map(type => makeChunk(type, chunks.get(type)))]);
}

function corruptChunkCrc(png, targetType) {
  const broken = Buffer.from(png);
  for (let offset = 8; offset < broken.length;) {
    const length = broken.readUInt32BE(offset), type = broken.toString('ascii', offset + 4, offset + 8);
    if (type === targetType) {
      broken[offset + 8 + length] ^= 1;
      return broken;
    }
    offset += length + 12;
  }
  throw new Error(`missing ${targetType} chunk`);
}

function hexAt(data, x, y, width) {
  const i = (Math.floor(x) + Math.floor(y) * width) * 4;
  if (data[i + 3] === 0) return '#00000000';
  return '#' + [0, 1, 2].map(c => data[i + c].toString(16).padStart(2, '0')).join('');
}

// BitmapStub in the style of collision-map.test.cjs, extended with readiness
// and a read counter so tests can prove when the Canvas fallback is used.
function BitmapStub(width, height, data) {
  this.width = width === undefined ? 1 : width;
  this.height = height === undefined ? 1 : height;
  this._data = data || Buffer.alloc(0);
  this.baseTexture = {};
  this._pixelData = [];
  this._reads = 0;
  this._context = {
    getImageData: (x, y, w, h) => {
      this._reads++;
      const start = (y * width + x) * 4;
      return { data: this._data.subarray(start, start + w * h * 4) };
    }
  };
}
BitmapStub.prototype.isReady = function() { return this._ready !== false; };
BitmapStub.prototype.addLoadListener = function(fn) {
  if (this.isReady()) fn(this);
  else (this._loadListeners ||= []).push(fn);
};
BitmapStub.prototype._setPixelData = function() {
  this._pixelData = this._context.getImageData(0, 0, this.width, this.height).data;
};
BitmapStub.prototype.getColor = function(x, y) {
  if (this._pixelData.length === 0) this._setPixelData();
  const i = (Math.floor(x) + Math.floor(y) * this.width) * 4;
  if (this._pixelData[i + 3] === 0) return '#00000000';
  return '#' + [0, 1, 2].map(c => this._pixelData[i + c].toString(16).padStart(2, '0')).join('');
};
BitmapStub.prototype._setDirty = function() { this.dirty = (this.dirty || 0) + 1; };

function guestContext(payload, pixels, width = 2, height = 2, initiallyReady = true, folder = 'img/parallaxes/') {
  const installed = [];
  const context = {
    console: { log() {} },
    PMJS: {
      plugins: {},
      phases: {
        on(event, owner, callback) { installed.push({ event, owner, callback }); }
      }
    },
    NativeHost: {
      assets: { portArtifact: name => name === 'felvidek-collision/coliziahrad' ? payload : null }
    },
    QMovement: { water1: '#00ff00', water2: '#0000ff' },
    QPlus: { getParams() { return { Folder: folder }; } },
    Utils: { isOptionValid: () => false },
    ImageManager: {
      loadBitmap() {
        context.stockLoads++;
        return new BitmapStub(width, height, pixels);
      }
    },
    Bitmap: BitmapStub,
    Game_CharacterBase: function() {},
    Game_Map: function() {},
    ColliderManager: {
      collisionMap: { bitmap: null },
      visible: false,
      container: { visible: false },
      show() { this.container.visible = true; },
      setCollisionMap(source) {
        this.collisionMap.bitmap = context.ImageManager.loadBitmap(folder, source);
        this.collisionMap.bitmap._ready = initiallyReady;
        this.lastSource = source;
        return this.collisionMap.bitmap;
      }
    }
  };
  context.Game_CharacterBase.prototype.passableColors = function() {
    const colors = ['#ffffff', '#00000000'];
    if ([1, 2, 3, 4].includes(this._passabilityLevel)) colors.push(context.QMovement.water1);
    if ([2, 4].includes(this._passabilityLevel)) colors.push(context.QMovement.water2);
    return colors;
  };
  context.Game_Map.prototype.collisionMapPass = function(collider, direction, colors) {
    return collider.isCircle ? this.collisionMapCirclePass(collider, direction, colors) :
      this.collisionMapBoxPass(collider, direction, colors);
  };
  context.Game_Map.prototype.collisionMapBoxPass = function() { return true; };
  context.Game_Map.prototype.collisionMapCirclePass = function() { return true; };
  context.Game_Map.prototype.insidePassableOnly = function(collider, colors) {
    return this.collisionMapBoxPass(collider, 'top', colors) &&
      this.collisionMapBoxPass(collider, 'bottom', colors);
  };
  context.globalThis = context;
  context.stockLoads = 0;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(adapterFile, 'utf8'), context);
  for (const entry of installed.filter(e => e.event === 'afterGuestPlugins')) entry.callback();
  return context;
}

test('preparer packs nonzero alpha as blocked and transparent alpha as passable', () => {
  const src = Buffer.from([
    255, 1, 1, 255, 5, 55, 66, 0, 255, 1, 43, 255, 255, 1, 1, 255,
    0, 0, 0, 0, 255, 1, 43, 255, 255, 1, 1, 255, 0, 0, 0, 0,
    0, 0, 0, 0, 255, 1, 1, 255, 255, 1, 43, 255, 255, 1, 43, 255
  ]);
  const result = preparer.generate(pngRGBA(4, 3, src));
  assert.equal(result.readUInt32LE(8), 4);
  assert.equal(result.length, 16 + 2);
  assert.deepEqual(enumerateOccupancy(result, 4, 3), [
    true, false, true, true,
    false, true, true, false,
    false, true, true, true
  ]);
});

test('preparer treats every nonzero alpha as blocked and refuses passable RGB pixels', () => {
  const partial = preparer.generate(pngRGBA(1, 1, Buffer.from([255, 12, 99, 128])));
  assert.equal(blockedAt(partial, 0, 0), true);
  assert.equal(preparer.generate(pngRGBA(1, 1, Buffer.from([255, 255, 255, 255]))), null);
  assert.equal(preparer.generate(pngRGBA(1, 1, Buffer.from([0, 128, 0, 1]))), null,
    'rejects a pixel that rounds to a passable green during Canvas readback');
  assert.equal(preparer.generate(pngRGBA(1, 1, Buffer.from([0, 0, 128, 1]))), null,
    'rejects a pixel that rounds to a passable blue during Canvas readback');
  assert.equal(preparer.generate(pngRGBA(1, 1, Buffer.from([128, 128, 128, 1]))), null,
    'rejects a pixel that rounds to passable white during Canvas readback');
});

test('preparer decodes every PNG scanline filter', () => {
  const pixels = Buffer.from([
    20, 40, 60, 255, 0, 0, 0, 0,
    80, 100, 120, 1, 140, 160, 180, 128,
    200, 220, 240, 255, 50, 60, 70, 0
  ]);
  const result = preparer.generate(pngRGBA(2, 3, pixels, [1, 3, 4]));
  assert.deepEqual(enumerateOccupancy(result, 2, 3), [true, false, true, true, true, false]);
});

test('preparer validates chunk checksums and rejects illegal chunk order', () => {
  const valid = pngRGBA(1, 1, Buffer.from([20, 40, 60, 255]));
  assert.ok(preparer.generate(valid));
  assert.equal(preparer.generate(corruptChunkCrc(valid, 'IDAT')), null);
  assert.equal(preparer.generate(reorderChunks(valid, ['IHDR', 'IEND', 'IDAT'])), null);
});

test('collision-only loader keeps a genuine empty Bitmap on the collision Sprite', () => {
  const pixels = Buffer.from([
    255, 1, 1, 255, 0, 0, 0, 0,
    255, 1, 43, 255, 255, 1, 1, 255
  ]);
  const payload = preparer.generate(pngRGBA(2, 2, pixels));
  const context = guestContext(payload, pixels);
  context.ColliderManager.setCollisionMap('coliziahrad');
  const bitmap = context.ColliderManager.collisionMap.bitmap;
  assert.ok(bitmap instanceof context.Bitmap);
  assert.ok(bitmap.baseTexture);
  assert.equal(bitmap.isReady(), true);
  assert.equal(context.ColliderManager.collisionMap.bitmap, bitmap);
  assert.deepEqual([
    bitmap.getColor(0, 0), bitmap.getColor(1, 0),
    bitmap.getColor(0, 1), bitmap.getColor(-1, 1)
  ], ['#010101', '#00000000', '#010101', '#00000000']);
  assert.equal(bitmap.width, 1, 'only the engine Bitmap minimum backing is allocated');
  assert.equal(bitmap.height, 1);
  assert.equal(bitmap._pmjsFelvidekCollisionMask.width, 2);
  assert.equal(bitmap._pmjsFelvidekCollisionMask.height, 2);
  assert.equal(bitmap.getColor(2, 0), '#00000000');
  assert.equal(bitmap.getColor(0, 2), '#00000000');
  assert.equal(bitmap.getColor(0.9, 0.9), '#010101');
  assert.equal(context.stockLoads, 0);
  assert.ok(bitmap._pmjsFelvidekCollisionMask);
});

test('fallback preserves palette compaction for non-mask collision images', () => {
  const pixels = Buffer.from([
    255, 1, 1, 255, 0, 0, 0, 0,
    255, 1, 43, 255, 255, 1, 1, 255
  ]);
  const payload = preparer.generate(pngRGBA(2, 2, pixels));
  const context = guestContext(payload, pixels);
  context.NativeHost.assets.portArtifact = () => null;
  context.ColliderManager.setCollisionMap('coliziahrad');
  const bitmap = context.ColliderManager.collisionMap.bitmap;
  assert.equal(bitmap.getColor(0, 0), '#ff0101');
  bitmap._data = Buffer.from([
    17, 1, 1, 255, 0, 0, 0, 0,
    255, 1, 43, 255, 255, 1, 1, 255
  ]);
  bitmap._setDirty();
  assert.equal(bitmap.getColor(0, 0), '#110101');
  assert.ok(bitmap._pmjsFelvidekCollisionData);
});

test('sources without prepared data keep the adapter compact path', () => {
  const pixels = Buffer.from(Buffer.alloc(2 * 2 * 4, 200).fill(255, 3).fill(255, 7));
  const context = guestContext(null, pixels);
  context.ColliderManager.setCollisionMap('not-a-prepared-source');
  const bitmap = context.ColliderManager.collisionMap.bitmap;
  assert.equal(bitmap._pmjsFelvidekPrepared, undefined);
  assert.equal(bitmap.getColor(0, 0), hexAt(pixels, 0, 0, 2));
  assert.ok(bitmap._pmjsFelvidekCollisionData);
});


test('debug mode retains the stock collision Bitmap for visualization', () => {
  const pixels = Buffer.from([
    255, 1, 1, 255, 0, 0, 0, 0,
    255, 1, 43, 255, 255, 1, 1, 255
  ]);
  const payload = preparer.generate(pngRGBA(2, 2, pixels));
  const context = guestContext(payload, pixels);
  context.Utils.isOptionValid = option => option === 'test';
  context.ColliderManager.setCollisionMap('coliziahrad');
  const bitmap = context.ColliderManager.collisionMap.bitmap;
  assert.ok(bitmap instanceof context.Bitmap);
  assert.equal(context.stockLoads, 1);
});

test('unsupported passable-color configuration uses the stock Bitmap and compact fallback', () => {
  const pixels = Buffer.from([255, 1, 1, 255]);
  const payload = preparer.generate(pngRGBA(1, 1, pixels));
  const context = guestContext(payload, pixels, 1, 1);
  context.QMovement.water1 = '#ff0000';
  context.ColliderManager.setCollisionMap('coliziahrad');
  const bitmap = context.ColliderManager.collisionMap.bitmap;
  assert.ok(bitmap instanceof context.Bitmap);
  assert.equal(context.stockLoads, 1);
  assert.equal(bitmap.getColor(0, 0), '#ff0101');
  assert.ok(bitmap._pmjsFelvidekCollisionData);
});

test('an unsupported per-query passable-color override downgrades the mask safely', () => {
  const pixels = Buffer.from([255, 1, 1, 255]);
  const payload = preparer.generate(pngRGBA(1, 1, pixels));
  const context = guestContext(payload, pixels, 1, 1);
  context.ColliderManager.setCollisionMap('coliziahrad');
  const map = new context.Game_Map();
  assert.equal(context.ColliderManager.collisionMap.bitmap._pmjsFelvidekCollisionMask.bits[0], 1);
  assert.equal(map.collisionMapPass({ isCircle: false }, 'top', ['#ffffff', '#00000000', '#ff0000']), false,
    'the first unsupported query fails closed while the Bitmap path is restored');
  const bitmap = context.ColliderManager.collisionMap.bitmap;
  assert.ok(bitmap instanceof context.Bitmap);
  assert.ok(bitmap._pmjsFelvidekCollision);
  assert.equal(context.stockLoads, 1);
  assert.equal(map.collisionMapPass({ isCircle: false }, 'top', ['#ffffff', '#00000000']), true);
});

test('insidePassableOnly downgrades unsupported colors through its direct box path', () => {
  const pixels = Buffer.from([255, 1, 1, 255]);
  const context = guestContext(preparer.generate(pngRGBA(1, 1, pixels)), pixels, 1, 1);
  context.ColliderManager.setCollisionMap('coliziahrad');
  const map = new context.Game_Map();
  assert.equal(map.insidePassableOnly({}, ['#ffffff', '#00000000', '#ff0000']), false);
  assert.ok(context.ColliderManager.collisionMap.bitmap instanceof context.Bitmap);
  assert.equal(context.stockLoads, 1);
});

test('configured-folder mismatch keeps the stock image and unrelated image loads untouched', () => {
  const pixels = Buffer.from([255, 1, 1, 255]);
  const payload = preparer.generate(pngRGBA(1, 1, pixels));
  const context = guestContext(payload, pixels, 1, 1, true, 'img/other/');
  context.ColliderManager.setCollisionMap('coliziahrad');
  assert.ok(context.ColliderManager.collisionMap.bitmap instanceof context.Bitmap);
  assert.equal(context.stockLoads, 1);
  context.ImageManager.loadBitmap('img/parallaxes/', 'coliziahrad');
  assert.equal(context.stockLoads, 2, 'ImageManager calls are never intercepted');
});

test('missing effective collision query methods disables the prepared mask', () => {
  const pixels = Buffer.from([255, 1, 1, 255]);
  const context = guestContext(preparer.generate(pngRGBA(1, 1, pixels)), pixels, 1, 1);
  context.Game_Map.prototype.collisionMapCirclePass = undefined;

  context.ColliderManager.setCollisionMap('coliziahrad');

  const bitmap = context.ColliderManager.collisionMap.bitmap;
  assert.equal(bitmap._pmjsFelvidekCollisionMask, undefined);
  assert.equal(bitmap._pmjsFelvidekCollision, true);
  assert.equal(context.stockLoads, 1);
});

test('showing collision debug geometry restores the original image before display', () => {
  const pixels = Buffer.from([255, 1, 1, 255]);
  const context = guestContext(preparer.generate(pngRGBA(1, 1, pixels)), pixels, 1, 1);
  context.ColliderManager.setCollisionMap('coliziahrad');
  assert.ok(context.ColliderManager.collisionMap.bitmap._pmjsFelvidekCollisionMask);
  context.ColliderManager.show();
  assert.ok(context.ColliderManager.collisionMap.bitmap instanceof context.Bitmap);
  assert.equal(context.ColliderManager.container.visible, true);
  assert.equal(context.stockLoads, 1);
});

test('Bitmap mutation invalidates the mask and restores the authored collision image', () => {
  const pixels = Buffer.from([255, 1, 1, 255]);
  const context = guestContext(preparer.generate(pngRGBA(1, 1, pixels)), pixels, 1, 1);
  context.ColliderManager.setCollisionMap('coliziahrad');
  const maskBitmap = context.ColliderManager.collisionMap.bitmap;
  maskBitmap._setDirty();
  assert.equal(maskBitmap._pmjsFelvidekCollisionMask, null);
  assert.ok(context.ColliderManager.collisionMap.bitmap instanceof context.Bitmap);
  assert.equal(context.ColliderManager.collisionMap.bitmap.getColor(0, 0), '#ff0101');
  assert.equal(context.stockLoads, 1);
});

test('invalid or missing prepared artifacts fall back to the stock image loader', () => {
  const pixels = Buffer.from([255, 1, 1, 255]);
  for (const payload of [null, Buffer.from([80, 77, 67, 79, 76, 50, 0, 0])]) {
    const context = guestContext(payload, pixels, 1, 1);
    context.ColliderManager.setCollisionMap('coliziahrad');
    const bitmap = context.ColliderManager.collisionMap.bitmap;
    assert.ok(bitmap instanceof context.Bitmap);
    assert.equal(context.stockLoads, 1);
  }
});

test('discovery matches collision PNGs without enumerating names', () => {
  const result = preparer.discover({files: [
    'img/parallaxes/coliziahrad.png', 'img/parallaxes/coliziaanother.png',
    'img/pictures/coliziaother.png', 'img/parallaxes/!hrad.png'
  ]});
  assert.deepEqual(result, [
    {source:'img/parallaxes/coliziahrad.png'},
    {source:'img/parallaxes/coliziaanother.png'}
  ]);
});



test('map changes replace the prior mask synchronously when the next artifact is missing', () => {
  const pixels = Buffer.from([
    255, 1, 1, 255, 0, 0, 0, 0,
    255, 1, 43, 255, 255, 1, 1, 255
  ]);
  const context = guestContext(preparer.generate(pngRGBA(2, 2, pixels)), pixels);
  context.ColliderManager.setCollisionMap('coliziahrad');
  const first = context.ColliderManager.collisionMap.bitmap;
  assert.equal(context.ColliderManager.collisionMap.bitmap, first);
  assert.equal(first.getColor(0, 0), '#010101');
  context.ColliderManager.setCollisionMap('coliziaother');
  const second = context.ColliderManager.collisionMap.bitmap;
  assert.equal(context.ColliderManager.collisionMap.bitmap, second);
  assert.notEqual(context.ColliderManager.collisionMap.bitmap, first);
  assert.equal(context.stockLoads, 1, 'missing second mask uses the original loader');
});
