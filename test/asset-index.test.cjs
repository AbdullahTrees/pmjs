'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { loadAssetIndex } = require('../runner/asset-index.cjs');
const { COMPILER_VERSION } = require('../runner/map-demand.cjs');
const identity = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture() {
  const root = temporaryDirectory('asset-index-'), file = path.join(root, 'index.json');
  const native = { assets: { preparationVersion: { processor: 1 }, tilePreparationVersion: 'tiles-1', preparationLz4Version: 'sparse-palette-v2' } };
  const options = { width: 816, height: 624, assetPreparation: { recipes: [], pageCodec: 'lz4' } };
  const index = { schema: 2, kind: 'pmjs-asset-index',
    sections: { images: 1, negativeHints: 1, mapCompilation: 1, tileOutputs: 1 },
    processor: native.assets.preparationVersion, tileProcessor: native.assets.tilePreparationVersion,
    recipesIdentity: identity([]), pageCodec: 'lz4', pageCodecVersion: native.assets.preparationLz4Version, width: 816, height: 624, configSha256: 'old',
    images: [{ source: 'img/pictures/a.png', outputs: [] }], negativeHints: ['img/pictures/b.png'],
    maps: { compiler: COMPILER_VERSION, compilations: { key: 'compilation' }, mapInputs: { name: 'contract' },
      entries: [{ identity: 'entry', outputs: [] }] } };
  const load = () => { fs.writeFileSync(file, JSON.stringify(index)); return loadAssetIndex(file, native, options); };
  return { index, native, options, load };
}

test('portable index reuses independent sections across configuration, viewport and processor changes', () => {
  const f = fixture();
  assert.equal(f.load().images.length, 1, 'unrelated config checksum does not discard decisions');
  f.native.assets.tilePreparationVersion = 'tiles-2';
  let loaded = f.load();
  assert.equal(loaded.images.length, 1); assert.deepEqual(loaded.maps.entries, []);
  assert.deepEqual(loaded.maps.compilations, f.index.maps.compilations);
  f.native.assets.tilePreparationVersion = 'tiles-1'; f.options.width = 1280;
  loaded = f.load();
  assert.equal(loaded.images.length, 1); assert.deepEqual(loaded.maps.entries, []);
  f.options.width = 816; f.native.assets.preparationVersion = { processor: 2 };
  loaded = f.load();
  assert.deepEqual(loaded.images, []); assert.equal(loaded.maps.entries.length, 1);
  assert.deepEqual(loaded.negativeHints, f.index.negativeHints);
  f.index.maps.compiler = 'unsupported';
  assert.equal(f.load().maps, null);
});

test('recipe, codec and section versions only invalidate the affected index sections', () => {
  for (const field of ['recipes', 'pageCodec', 'losslessPrefixes', 'astc', 'astcQuality', 'images', 'mapCompilation', 'tileOutputs', 'negativeHints']) {
    const f = fixture();
    if (field === 'astc') f.options.assetPreparation.astc = { enabled: true };
    else if (field === 'astcQuality') f.options.assetPreparation.astc = { enabled: false, quality: 'thorough' };
    else if (field === 'losslessPrefixes') f.options.assetPreparation.losslessPrefixes = ['img/masks/'];
    else if (field === 'recipes') f.options.assetPreparation.recipes = [{ changed: true }];
    else if (field === 'pageCodec') f.options.assetPreparation.pageCodec = 'png';
    else f.index.sections[field] = 99;
    const loaded = f.load();
    if (['recipes', 'pageCodec', 'losslessPrefixes', 'astc', 'astcQuality', 'images'].includes(field)) {
      assert.deepEqual(loaded.images, []); assert.equal(loaded.maps.entries.length, 1);
    } else if (field === 'mapCompilation') assert.equal(loaded.maps, null);
    else if (field === 'tileOutputs') assert.deepEqual(loaded.maps.entries, []);
    else assert.deepEqual(loaded.negativeHints, []);
  }
});

test('legacy indexes retain strict content decisions without gaining unverified negative hints', () => {
  const f = fixture(); f.index.schema = 1;
  const loaded = f.load();
  assert.equal(loaded.images.length, 1); assert.equal(loaded.maps.entries.length, 1);
  assert.deepEqual(loaded.negativeHints, []);
});

test('an invalid image section does not discard valid map compilation or tile outputs', () => {
  const f = fixture(); f.index.images = null;
  const loaded = f.load();
  assert.deepEqual(loaded.images, []); assert.equal(loaded.maps.entries.length, 1);
});

test('storage decisions require their own supported version and valid layout', () => {
  const f = fixture();
  const storage = { version: 1, width: 2048, height: 2048, channels: 4,
    paletteBits: 8, source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3] };
  f.index.sections.imageStorage = 1;
  f.index.imageStorageVersion = f.native.assets.imageStorageVersion = 1;
  f.index.images[0].storage = storage;
  assert.deepEqual(f.load().images[0].storage, storage);
  const facts = { ...storage, pixelFactsVersion: 1, opaque: true, allZero: false, sparseRegions: null };
  f.index.images[0].storage = facts;
  assert.deepEqual(f.load().images[0].storage, facts);
  for (const invalid of [{ ...facts, allZero: true }, { ...facts, sparseRegions: [[2040, 0, 32, 32]] },
    { ...facts, sparseRegions: 'unknown' }, { ...facts, pixelFactsVersion: 2 }]) {
    f.index.images[0].storage = invalid;
    assert.equal(f.load().images[0].storage, undefined);
  }
  f.index.images[0].storage = storage;
  f.index.imageStorageVersion = 2;
  assert.equal(f.load().images[0].storage, undefined);
  f.index.imageStorageVersion = 1;
  f.index.images[0].storage = { ...storage, paletteBits: 12 };
  assert.equal(f.load().images[0].storage, undefined);
  f.index.images[0].storage = { ...storage, channels: 1, swizzle: [0, 1, 0, 5] };
  assert.equal(f.load().images[0].storage, undefined);
  assert.equal(f.load().images.length, 1, 'bad storage metadata does not discard preparation layout');
});

test('LZ4 container versions invalidate image outputs without discarding independent sections', () => {
  const f = fixture();
  assert.equal(f.load().images.length, 1);
  for (const version of [undefined, 'rgba-v1', 'future-v3']) {
    f.index.pageCodecVersion = version;
    const loaded = f.load();
    assert.deepEqual(loaded.images, []);
    assert.equal(loaded.maps.entries.length, 1);
    assert.deepEqual(loaded.negativeHints, f.index.negativeHints);
  }
  f.index.pageCodecVersion = f.native.assets.preparationLz4Version;
  assert.equal(f.load().images.length, 1);
  f.index.pageCodec = f.options.assetPreparation.pageCodec = 'png';
  delete f.index.pageCodecVersion;
  assert.equal(f.load().images.length, 1, 'PNG outputs do not depend on the LZ4 container');
});


test('portable settings survive incompatible calculated image data', () => {
  const f = fixture();
  f.index.schema = 3;
  const settings = { recipe: { grid: [3,4] }, lossless: true, astc: { enabled: false } };
  f.index.images = [{ source: 'img/pictures/a.png', settings, calculated: { sourceHash: 'old', outputs: [] } }];
  assert.deepEqual(f.load().policies['img/pictures/a.png'], settings);
  assert.equal(f.load().images[0].sourceHash, 'old');
  f.options.assetPreparation.recipes = [{ source: 'img/pictures/other.png', grid: [1,1] }];
  assert.equal(f.load().images.length, 1, 'unrelated settings do not invalidate all calculated records');
  f.native.assets.preparationVersion = { processor: 2 };
  const loaded = f.load();
  assert.deepEqual(loaded.images, []);
  assert.deepEqual(loaded.policies['img/pictures/a.png'], settings);
});
