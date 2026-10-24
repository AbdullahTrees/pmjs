'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const NativeUint32Array = Uint32Array;

const moduleFile = path.join(__dirname, '../../../patches/felvidek/collision-map.js');

function colorsFor(data, width, height, x, y) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= width || y >= height) return '#00000000';
  const index = (x + y * width) * 4;
  if (data[index + 3] === 0) return '#00000000';
  return '#' + [0, 1, 2].map(channel =>
    data[index + channel].toString(16).padStart(2, '0')).join('');
}

function bitmap(width, height, data) {
  return new BitmapStub(width, height, data);
}

function BitmapStub(width, height, data) {
  this.width = width;
  this.height = height;
  this._data = data;
  this._pixelData = [];
  this._reads = 0;
  this._context = {
    getImageData: (x, y, w, h) => {
      this._reads++;
      const start = (y * width + x) * 4;
      const end = start + w * h * 4;
      return { data: this._data.subarray(start, end) };
    }
  };
}
BitmapStub.prototype._setPixelData = function() {
  this._pixelData = this._context.getImageData(0, 0, this.width, this.height).data;
};
BitmapStub.prototype.getColor = function(x, y) {
  if (this._pixelData.length === 0) this._setPixelData();
  x = Math.floor(x); y = Math.floor(y);
  if (x >= this.width || x < 0 || y >= this.height || y < 0 || this._pixelData.length === 0) {
    return '#00000000';
  }
  const i = x * 4 + y * 4 * this.width;
  if (this._pixelData[i + 3] === 0) return '#00000000';
  let result = '#';
  for (let channel = 0; channel < 3; channel++) {
    result += this._pixelData[i + channel].toString(16).padStart(2, '0');
  }
  return result;
};
BitmapStub.prototype._setDirty = function() { this.dirty = (this.dirty || 0) + 1; };

function load(options = {}) {
  let install = null;
  const context = {
    PMJS: { phases: { on: (event, owner, callback) => {
      if (event === 'afterGuestPlugins') install = callback;
    } } },
    Bitmap: BitmapStub,
    Uint32Array: options.forceGeneric ? function(buffer, byteOffset, length) {
      if (byteOffset !== undefined) throw new Error('force generic palette path');
      return new NativeUint32Array(buffer);
    } : NativeUint32Array,
    ColliderManager: {
      collisionMap: { bitmap: null },
      setCollisionMap(bitmap) { this.collisionMap.bitmap = bitmap; }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(moduleFile, 'utf8'), context);
  assert.equal(typeof install, 'function');
  return { context, install };
}

function rgba(...pixels) {
  return new Uint8ClampedArray(pixels.flat());
}

function assertParity(bitmap, width, height) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      assert.equal(bitmap.getColor(x, y), colorsFor(bitmap._data, width, height, x, y),
        `pixel ${x},${y}`);
    }
  }
}

test('packed collision colors preserve transparent, partial-alpha and out-of-bounds results', () => {
  const width = 4, height = 4;
  const data = rgba(
    [255, 1, 1, 255], [0, 0, 0, 0], [255, 1, 43, 255], [18, 52, 86, 128],
    [18, 52, 86, 1], [255, 1, 1, 255], [0, 0, 0, 0], [255, 1, 43, 255],
    [0, 0, 0, 0], [18, 52, 86, 255], [255, 1, 1, 64], [255, 1, 43, 255],
    [255, 1, 43, 0], [255, 1, 1, 255], [18, 52, 86, 200], [0, 0, 0, 0]
  );
  const context = load();
  context.install();
  const map = new context.context.Bitmap(width, height, data);
  context.context.ColliderManager.setCollisionMap(map);
  assert.equal(map._pmjsFelvidekCollision, true);
  assert.equal(map.getColor(0, 0), '#ff0101');
  assert.equal(map.getColor(1, 0), '#00000000');
  assert.equal(map.getColor(2, 0), '#ff012b');
  assert.equal(map.getColor(3, 0), '#123456');
  assert.equal(map.getColor(0, 1), '#123456');
  assert.equal(map.getColor(3, 3), '#00000000');
  assert.equal(map.getColor(-1, 0), '#00000000');
  assert.equal(map.getColor(0, 4), '#00000000');
  assert.equal(map.getColor(3.9, 1.9), '#ff012b');
  assert.equal(map._pixelData.length, 0);
  assert.equal(map._pmjsFelvidekCollisionData.bits, 2);
  assert.equal(map._pmjsFelvidekCollisionData.packed.length, Math.ceil(width * height * 2 / 8));
  assertParity(map, width, height);
});

test('two colors use one-bit storage and fifteen colors use four-bit storage', () => {
  const two = load();
  two.install();
  const twoColors = rgba(
    [255, 1, 1, 255], [0, 0, 0, 0], [255, 1, 1, 255],
    [0, 0, 0, 0], [255, 1, 1, 255], [0, 0, 0, 0]
  );
  const twoMap = new two.context.Bitmap(3, 2, twoColors);
  two.context.ColliderManager.setCollisionMap(twoMap);
  twoMap.getColor(0, 0);
  assert.equal(twoMap._pmjsFelvidekCollisionData.bits, 1);
  assertParity(twoMap, 3, 2);

  const many = load();
  many.install();
  const colors = [];
  for (let index = 0; index < 15; index++) colors.push([index, index + 1, index + 2, 255]);
  const manyData = rgba(...colors);
  const manyMap = new many.context.Bitmap(15, 1, manyData);
  many.context.ColliderManager.setCollisionMap(manyMap);
  manyMap.getColor(0, 0);
  assert.equal(manyMap._pmjsFelvidekCollisionData.bits, 4);
  assertParity(manyMap, 15, 1);
});

test('a third color expands one-bit storage during the scan', () => {
  const loaded = load();
  loaded.install();
  const data = rgba(
    [255, 1, 1, 255], [0, 0, 0, 0], [255, 1, 1, 255], [0, 0, 0, 0],
    [0, 0, 255, 255], [255, 1, 1, 255]
  );
  const map = new loaded.context.Bitmap(6, 1, data);
  loaded.context.ColliderManager.setCollisionMap(map);
  assert.equal(map.getColor(0, 0), '#ff0101');
  assert.equal(map._pmjsFelvidekCollisionData.bits, 2);
  assert.equal(map._pmjsFelvidekCollisionData.packed.length, Math.ceil(6 * 2 / 8));
  assert.equal(map._pmjsFelvidekCollisionData.palette.join(','),
    '#ff0101,#00000000,#0000ff');
  assertParity(map, 6, 1);
});

test('four colors stay at two bits when the last color appears late', () => {
  const loaded = load();
  loaded.install();
  const data = rgba(
    [255, 1, 1, 255], [0, 0, 0, 0], [255, 1, 1, 255], [0, 0, 0, 0],
    [255, 1, 43, 255], [0, 0, 0, 0], [18, 52, 86, 255], [0, 0, 0, 0]
  );
  const map = new loaded.context.Bitmap(8, 1, data);
  loaded.context.ColliderManager.setCollisionMap(map);
  assert.equal(map.getColor(0, 0), '#ff0101');
  assert.equal(map._pmjsFelvidekCollisionData.bits, 2);
  assert.equal(map._pmjsFelvidekCollisionData.packed.length, Math.ceil(8 * 2 / 8));
  assert.equal(map._pmjsFelvidekCollisionData.palette.join(','),
    '#ff0101,#00000000,#ff012b,#123456');
  assertParity(map, 8, 1);
});

test('an initial opaque black pixel is encoded correctly in fast and generic paths', () => {
  const data = rgba([0, 0, 0, 255], [0, 0, 0, 0], [18, 52, 86, 255]);
  for (const options of [{}, { forceGeneric: true }]) {
    const loaded = load(options);
    loaded.install();
    const map = new loaded.context.Bitmap(3, 1, data);
    loaded.context.ColliderManager.setCollisionMap(map);
    assert.equal(map.getColor(0, 0), '#000000');
    assert.equal(map.getColor(1, 0), '#00000000');
    assert.equal(map.getColor(2, 0), '#123456');
    assertParity(map, 3, 1);
  }
});

test('more than 256 colors fall back to the retained original pixel array', () => {
  const width = 20, height = 20;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = index & 255;
    data[index * 4 + 1] = (index >> 8) & 255;
    data[index * 4 + 2] = 7;
    data[index * 4 + 3] = 255;
  }
  const loaded = load();
  loaded.install();
  const map = new loaded.context.Bitmap(width, height, data);
  loaded.context.ColliderManager.setCollisionMap(map);
  map.getColor(0, 0);
  assert.equal(map._pmjsFelvidekCollisionData, null);
  assert.equal(map._pixelData.length, width * height * 4);
  assertParity(map, width, height);
});

test('unmarked bitmaps keep the stock full-surface snapshot', () => {
  const loaded = load();
  loaded.install();
  const data = rgba([255, 1, 1, 255], [0, 0, 0, 0]);
  const map = new loaded.context.Bitmap(2, 1, data);
  assert.equal(map.getColor(0, 0), '#ff0101');
  assert.equal(map._pmjsFelvidekCollisionData, undefined);
  assert.equal(map._pixelData.length, 2 * 1 * 4);
});

test('dirtying a compact bitmap invalidates it and rebuilds from new pixels', () => {
  const loaded = load();
  loaded.install();
  const first = rgba([255, 1, 1, 255], [0, 0, 0, 0], [255, 1, 1, 255], [0, 0, 0, 0]);
  const map = new loaded.context.Bitmap(2, 2, first);
  loaded.context.ColliderManager.setCollisionMap(map);
  assert.equal(map.getColor(0, 0), '#ff0101');
  assert.ok(map._pmjsFelvidekCollisionData);
  map._data = rgba([0, 0, 255, 255], [0, 0, 255, 255], [0, 0, 0, 0], [0, 0, 0, 0]);
  map._setDirty();
  assert.equal(map._pmjsFelvidekCollisionData, null);
  assert.equal(map._pixelData.length, 0);
  assert.equal(map.getColor(0, 0), '#0000ff');
  assert.ok(map._pmjsFelvidekCollisionData);
  assertParity(map, 2, 2);
});

test('an explicit pixel refresh rebuilds the compact representation', () => {
  const loaded = load();
  loaded.install();
  const data = rgba([255, 1, 1, 255], [0, 0, 0, 0]);
  const map = new loaded.context.Bitmap(2, 1, data);
  loaded.context.ColliderManager.setCollisionMap(map);
  assert.equal(map.getColor(0, 0), '#ff0101');
  assert.equal(map._pmjsFelvidekCollisionData.palette[0], '#ff0101');
  map._data = rgba([0, 0, 255, 255], [0, 0, 0, 0]);
  map._setPixelData();
  assert.equal(map.getColor(0, 0), '#0000ff');
  assert.equal(map._pmjsFelvidekCollisionData.palette[0], '#0000ff');
});

test('a manually restored pixel array invalidates the compact representation', () => {
  const loaded = load();
  loaded.install();
  const data = rgba([255, 1, 1, 255], [0, 0, 0, 0]);
  const map = new loaded.context.Bitmap(2, 1, data);
  loaded.context.ColliderManager.setCollisionMap(map);
  assert.equal(map.getColor(0, 0), '#ff0101');
  map._pixelData = Uint8ClampedArray.from([0, 0, 255, 255, 0, 0, 0, 0]);
  assert.equal(map.getColor(0, 0), '#0000ff');
  assert.equal(map._pmjsFelvidekCollisionData, null);
});

test('large images are read in bounded chunks rather than one full readback', () => {
  const width = 1100, height = 1000;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = 255;
    data[index * 4 + 1] = index & 1;
    data[index * 4 + 2] = 1;
    data[index * 4 + 3] = 255;
  }
  const loaded = load();
  loaded.install();
  const map = new loaded.context.Bitmap(width, height, data);
  loaded.context.ColliderManager.setCollisionMap(map);
  map.getColor(0, 0);
  assert.ok(map._pmjsFelvidekCollisionData);
  assert.ok(map._reads > 1);
  assert.equal(map._pmjsFelvidekCollisionData.bits, 1);
  assert.equal(map.getColor(0, 0), colorsFor(data, width, height, 0, 0));
  assert.equal(map.getColor(width - 1, height - 1), colorsFor(data, width, height, width - 1, height - 1));
});

test('repeated installation preserves the same wrappers and ordinary bitmap behavior', () => {
  const loaded = load();
  assert.equal(loaded.install(), true);
  const bitmapMethod = loaded.context.Bitmap.prototype.getColor;
  const setCollisionMap = loaded.context.ColliderManager.setCollisionMap;
  assert.equal(loaded.install(), true);
  assert.equal(loaded.context.Bitmap.prototype.getColor, bitmapMethod);
  assert.equal(loaded.context.ColliderManager.setCollisionMap, setCollisionMap);
  const bitmap = new loaded.context.Bitmap(1, 1, rgba([1, 2, 3, 255]));
  assert.equal(bitmap.getColor(0, 0), '#010203');
  assert.equal(bitmap._pixelData.length, 4);
});
