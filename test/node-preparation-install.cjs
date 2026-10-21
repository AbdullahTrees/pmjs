'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers/map-preparation.cjs');
const { prepareGameAssets } = require('../runner/preparation.cjs');
const { generateAssetIndex } = require('../runner/asset-index.cjs');
const { buildPortPreparation, verifyPortDescriptor } = require('../runner/port-preparation.cjs');
const native = require(path.resolve(process.argv[2]));
const f = fixture();
let prepared;
fs.writeFileSync(path.join(f.gameRoot, 'source.bin'), 'input');
(async () => {
  native.initialize({ gameRoot: f.gameRoot, width: 32, height: 24, windowTitle: 'Preparation installation', imageWarmCacheBytes: 0 });
  try {
    prepared = await prepareGameAssets({ gameRoot: f.gameRoot, cacheRoot: f.cacheRoot, native,
      images: true, maps: true, pageCodec: 'png', logger: { warn() {} } });
    assert.equal(prepared.images.installed, 2);
    assert.equal(prepared.maps.installed, 1);
    const [first, second] = prepared.images.entries;
    const malformed = { ...first, descriptor: { ...first.descriptor, width: 0 } };
    const throwing = { ...first };
    Object.defineProperty(throwing, 'descriptor', { get() { throw new Error('fixture getter failure'); } });
    const report = native.assets.installPrepared([malformed, throwing, second], false, true);
    assert.deepEqual(report.accepted, [second.source]);
    assert.equal(report.rejected.length, 2);
    assert.ok(report.rejected.every(item => item.id === first.source && item.reason));
    const image = native.images.load(second.source);
    assert.equal(image.width, 512);
    native.images.release(image.handle);

    const storage = await native.assets.classifyImageStorage(native.assets.sourcePath(second.source));
    const storageReport = native.assets.installImageStorage([
      { source: first.source, sourceIdentity: first.sourceIdentity, storage: { ...storage, width: 0 } },
      { source: second.source, sourceIdentity: second.sourceIdentity, backingHash: second.backingHash, storage }
    ], true);
    assert.deepEqual(storageReport.accepted, [second.source]);
    assert.equal(storageReport.rejected.length, 1);

    const tiles = prepared.maps.entries[0];
    const rejectedTiles = { ...tiles, identity: 'invalid-map', descriptor: { ...tiles.descriptor,
      sources: [{ ...tiles.descriptor.sources[0], source: 'img/tilesets/missing.png' }] } };
    const tileReport = native.assets.installTileSets([rejectedTiles, tiles], false, true);
    assert.deepEqual(tileReport.accepted, [tiles.identity]);
    assert.equal(tileReport.rejected[0].id, 'invalid-map');

    native.assets.installPrepared([first], false, true);
    fs.appendFileSync(native.assets.sourcePath(first.source), 'changed source');
    const changed = native.images.load(first.source);
    assert.ok(changed);
    native.images.release(changed.handle);
    assert.ok(native.assets.consumePreparationFailures().includes(native.assets.sourcePath(first.source)));
    const root = path.dirname(f.gameRoot), runtime = path.join(root, 'runtime'), bundleRoot = path.join(root, 'bundle');
    fs.mkdirSync(path.join(runtime, 'lib'), { recursive: true });
    fs.symlinkSync(path.resolve(process.argv[2]), path.join(runtime, 'lib/pmjs_native.node'));
    fs.mkdirSync(bundleRoot);
    const processor = path.join(root, 'fixture.pmjs-processor.cjs');
    fs.writeFileSync(processor, `module.exports = { id: 'fixture', version: 1,
      discover({ files }) { return files.filter(file => file.endsWith('.bin')).map(source => ({ source, id: 'data' })); },
      generate(bytes) { return Buffer.concat([Buffer.from('prepared:'), bytes]); } };`);
    const portDescriptors = buildPortPreparation({ bundleRoot, processors: [processor] });
    const packaged = await generateAssetIndex({ root: runtime, gameRoot: f.gameRoot, output: bundleRoot,
      options: { width: 32, height: 24, assetPreparation: { enabled: false, recipes: [], maps: false } },
      portDescriptors, includePortAssets: true, writeIndex: false });
    assert.equal(packaged.warningCount, 0);
    assert.equal(verifyPortDescriptor(bundleRoot, portDescriptors).size, 1);
    const supplied = JSON.stringify(portDescriptors);
    const packagedOptions = { gameRoot: f.gameRoot, cacheRoot: path.join(root, 'packaged-cache'), native,
      images: false, maps: false, bundleRoot, portDescriptors, logger: { warn() {} } };
    const reused = await prepareGameAssets(packagedOptions);
    assert.equal(reused.outcomeCounts['reused-package'], 1);
    assert.deepEqual(Buffer.from(native.assets.decompressPortArtifact(fs.readFileSync(reused.portArtifacts.get('fixture/data')))), Buffer.from('prepared:input'));
    reused.releaseCacheLease?.();
    fs.appendFileSync(portDescriptors[0].outputs[0].file && path.join(bundleRoot, portDescriptors[0].outputs[0].file), 'damaged');
    const repaired = await prepareGameAssets({ ...packagedOptions, cacheRoot: path.join(root, 'repair-cache') });
    assert.equal(repaired.outcomeCounts.generated, 1);
    assert.equal(JSON.stringify(portDescriptors), supplied);
    repaired.releaseCacheLease?.();
    console.log('Preparation installs isolate malformed records and report deferred failures');
  } finally {
    prepared?.releaseCacheLease?.();
    native.runtime.quit();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
