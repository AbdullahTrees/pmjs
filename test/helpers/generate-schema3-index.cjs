'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [bundle, gameRoot, fixtureRoot] = process.argv.slice(2).map(value => path.resolve(value));
const source = 'img/pictures/index-fixture.png';
fs.mkdirSync(path.join(gameRoot, path.dirname(source)), { recursive: true });
fs.writeFileSync(path.join(gameRoot, source), Buffer.from('fixture source image'));
const pageDirectory = path.join(fixtureRoot, 'prepared-image');
fs.mkdirSync(pageDirectory, { recursive: true });
const pageName = 'page.png';
const pageFile = path.join(pageDirectory, pageName);
fs.writeFileSync(pageFile, Buffer.from('generated image page'));
const pageHash = crypto.createHash('sha256').update(fs.readFileSync(pageFile)).digest('hex');

const preparationPath = require.resolve('../../runner/preparation.cjs');
require(preparationPath);
require.cache[preparationPath].exports.prepareGameAssets = async () => ({
  images: { total: 1, prepared: 1, decryptedEntries: [],
    entries: [{ source, directory: pageDirectory }],
    decisions: [{ source, sourceHash: 'a'.repeat(64), descriptor: null,
      outputs: { [pageName]: pageHash } }] },
  maps: null, records: {}, portArtifacts: new Map()
});

const addon = { assets: {
  ...require('./preparation-lock.cjs').preparationLocks(),
  imageStorageVersion: 1,
  preparationVersion: { processor: 'fixture' },
  tilePreparationVersion: 'fixture-tiles',
  preparationLz4Version: 'fixture-lz4',
  classifyImageStorage() { throw new Error('fixture omits storage classification'); }
} };
const nativeAddonPath = path.join(fixtureRoot, 'lib/pmjs_native.node');
fs.mkdirSync(path.dirname(nativeAddonPath), { recursive: true });
fs.writeFileSync(nativeAddonPath, 'fixture native addon');
require.extensions['.node'] = module => { module.exports = addon; };

const { generateAssetIndex } = require('../../runner/asset-index.cjs');
const descriptorPath = path.join(bundle, 'pmjs.json');
const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
const options = { width: 816, height: 624, assetPreparation: {
  enabled: true, maps: true, pageCodec: 'png', recipes: [], losslessPrefixes: [],
  astc: { enabled: false, quality: 'medium' }, workspaceBytes: 1024
} };

generateAssetIndex({ root: fixtureRoot, gameRoot, options, output: bundle, includeAssets: true })
  .then(() => {
    descriptor.assetIndex = 'asset-index.json';
    descriptor.assetIndexSha256 = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(bundle, descriptor.assetIndex))).digest('hex');
    descriptor.assets = 'assets';
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n');
  })
  .catch(error => { console.error(error); process.exitCode = 1; });
