'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { astcSettings, validDescriptor, validStorageDecision } = require('./asset-preparation.cjs');
const { validTileDescriptor } = require('./map-preparation.cjs');
const { prepareGameAssets } = require('./preparation.cjs');
const { COMPILER_VERSION } = require('./map-demand.cjs');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const identity = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function offlineFilesystem(gameRoot, derived) {
  const root = fs.realpathSync(gameRoot);
  const file = logical => {
    if (typeof logical !== 'string' || !logical ||
        !logical.split('/').every(part => part && part !== '.' && part !== '..') ||
        logical.includes('\\') || logical.includes('\0')) return null;
    if (derived.has(logical)) return derived.get(logical);
    const candidate = path.join(root, logical);
    if (!fs.existsSync(candidate)) return null;
    const resolved = fs.realpathSync(candidate);
    return resolved.startsWith(root + path.sep) ? resolved : null;
  };
  const exists = logical => file(logical) !== null;
  const assets = {
    sourcePath: logical => exists(logical) ? file(logical) : null,
    addDerived: (logical, file) => derived.set(logical, file),
    sourceIdentity: logical => {
      if (!exists(logical)) return null;
      const stat = fs.statSync(file(logical));
      return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    }
  };
  const game = {
    exists,
    isDirectory: logical => { try { return fs.statSync(path.join(root, logical)).isDirectory(); } catch { return false; } },
    readBytes: logical => exists(logical) ? fs.readFileSync(file(logical)) : null,
    readDirectory: logical => {
      const directory = logical === '.' || !logical ? root : file(logical);
      return directory && fs.statSync(directory).isDirectory() ? fs.readdirSync(directory) : null;
    }
  };
  return { assets, fs: game };
}

function portableMaps(result, includeAssets, output) {
  const mapInputs = Object.fromEntries(Object.entries(result.mapInputs || {}).map(([name, entry]) =>
    [name, { ...entry, dependencies: entry.dependencies.map(({ logical, hash }) => ({ logical, hash })) }]));
  const entries = [];
  for (const [mapId, selected] of Object.entries(result.index)) {
    const entry = result.entries.find(item => item.identity === selected.identity);
    const directory = entry.directory;
    const manifest = entry;
    if (!validTileDescriptor(manifest.descriptor)) throw new Error('invalid generated map descriptor');
    const pages = manifest.outputs.map(page => {
      const source = path.join(directory, page.path);
      if (hash(source) !== page.hash) throw new Error('generated map page changed');
      const relative = path.posix.join('assets/maps', selected.identity, page.path);
      if (includeAssets) {
        fs.mkdirSync(path.dirname(path.join(output, relative)), { recursive: true });
        fs.copyFileSync(source, path.join(output, relative));
      }
      return { ...page, path: relative };
    });
    entries.push({ mapId: Number(mapId), identity: selected.identity,
      descriptor: manifest.descriptor, outputs: pages, estimates: manifest.estimates });
  }
  return { compiler: COMPILER_VERSION, compilations: result.compilations || {}, mapInputs, entries };
}

async function generateAssetIndex({ root, gameRoot, options, output, includeAssets, portDescriptors = [], includePortAssets = false, writeIndex = true, shouldCancel = () => false }) {
  const nativeAddon = require(path.join(root, 'lib/pmjs_native.node'));
  const cacheRoot = path.join(output, '.preparation');
  const derived = new Map();
  const filesystem = offlineFilesystem(gameRoot, derived);
  const native = { assets: Object.assign(Object.create(nativeAddon.assets), filesystem.assets), fs: filesystem.fs };
  const warnings = [];
  const logger = { warn: message => warnings.push(message) };
  try {
    const prepared = await prepareGameAssets({ gameRoot, cacheRoot, native,
      ...options.assetPreparation, images: options.assetPreparation.enabled,
      maps: options.assetPreparation.enabled && options.assetPreparation.maps,
      preparationContext: 'offline', verifyHashes: true, logger, shouldCancel,
      width: options.width, height: options.height, bundleRoot: output, portDescriptors });
    const images = prepared.images || { total: 0, prepared: 0, decisions: [], entries: [], decryptedEntries: [] };
    let maps = prepared.maps || null;
    if (prepared.cancelled) throw new Error('asset preparation cancelled');
    if (images.error) warnings.push('[pmjs] image index incomplete: ' + images.error);
    if (maps?.error) { warnings.push('[pmjs] map index unavailable: ' + maps.error); maps = null; }
    for (const desc of portDescriptors) {
      desc.outputs = [];
      for (const record of Object.values(prepared.records || {})) {
        if (!record.id?.startsWith(desc.id + '/')) continue;
        const value = { id: record.id.slice(desc.id.length + 1), source: record.source, sourceSha256: record.sourceHash };
        const file = prepared.portArtifacts.get(record.id);
        if (file && includePortAssets) {
          value.file = 'assets/ports/' + desc.id + '/' + value.id + '.pma1';
          value.sha256 = hash(file);
          fs.mkdirSync(path.dirname(path.join(output, value.file)), { recursive: true });
          fs.copyFileSync(file, path.join(output, value.file));
        }
        desc.outputs.push(value);
      }
    }
    const imageEntries = new Map();
    images.entries.forEach((entry, index) => {
      if (!imageEntries.has(entry.source)) imageEntries.set(entry.source, { entry, index });
    });
    if (nativeAddon.assets.imageStorageVersion !== 1 || typeof nativeAddon.assets.classifyImageStorage !== 'function')
      throw new Error('image storage indexing requires a current host runtime');
    const decryptedInputs = new Map(images.decryptedEntries.map(entry => [entry.source, entry.file]));
    const imageRecords = [];
    for (const decision of images.decisions) {
      if (shouldCancel()) throw new Error('image storage indexing cancelled');
      if (decision.descriptor && !validDescriptor(decision.descriptor)) throw new Error('invalid generated image descriptor');
      const original = imageEntries.get(decision.source);
      const decrypted = imageEntries.get(decision.source.replace(/\.(png_|rpgmvp)$/i, '.png'));
      // Either source spelling can match; retain the first entry in preparation order.
      const entry = (!original || decrypted && decrypted.index < original.index ? decrypted : original)?.entry;
      const outputs = Object.entries(decision.outputs).map(([name, checksum]) => {
        if (!entry) throw new Error('missing generated image entry');
        const source = path.join(entry.directory, name);
        if (hash(source) !== checksum) throw new Error('generated image page changed');
        const relative = path.posix.join('assets/images', path.basename(entry.directory), name);
        if (includeAssets) {
          fs.mkdirSync(path.dirname(path.join(output, relative)), { recursive: true });
          fs.copyFileSync(source, path.join(output, relative));
        }
        return { path: relative, hash: checksum };
      });
      let storage;
      const transformsPixels = decision.recipe?.crop ||
        decision.recipe?.backdrop?.some(channel => channel !== 0);
      const imageSource = decision.source.replace(/\.(png_|rpgmvp)$/i, '.png');
      if (imageSource.toLowerCase().endsWith('.png') && !transformsPixels) {
        try {
          storage = await nativeAddon.assets.classifyImageStorage(
            decryptedInputs.get(decision.source) || filesystem.assets.sourcePath(decision.source));
          if (!validStorageDecision(storage)) throw new Error('invalid storage decision');
          if (hash(filesystem.assets.sourcePath(decision.source)) !== decision.sourceHash)
            throw new Error('image source changed during storage classification');
        } catch (error) {
          storage = undefined;
          warnings.push('[pmjs] image storage index unavailable ' + decision.source + ': ' + error.message);
        }
      }
      let descriptor = decision.descriptor;
      if (descriptor && !descriptor.compression) {
        const pages = [];
        for (const page of descriptor.pages) {
          if (shouldCancel()) throw new Error('page storage indexing cancelled');
          const pageStorage = await nativeAddon.assets.classifyImageStorage(path.join(entry.directory, page.path));
          if (!validStorageDecision(pageStorage) || pageStorage.width !== page.width || pageStorage.height !== page.height)
            throw new Error('invalid prepared page storage decision');
          const expected = decision.outputs[page.path];
          if (hash(path.join(entry.directory, page.path)) !== expected) throw new Error('prepared page changed during classification');
          pages.push({ ...page, storage: pageStorage });
        }
        descriptor = { ...descriptor, pages };
      }
      imageRecords.push({ ...decision, descriptor, ...(storage ? { storage } : {}), outputs });
    }
    const index = { schema: 3, kind: 'pmjs-asset-index',
      sections: { imageStorage: 1, images: 1, mapCompilation: 1, tileOutputs: 1 },
      pageCodec: options.assetPreparation.pageCodec,
      pageCodecVersion: options.assetPreparation.pageCodec === 'lz4' ? nativeAddon.assets.preparationLz4Version : null,
      losslessPrefixes: options.assetPreparation.losslessPrefixes || [],
      astc: astcSettings(options.assetPreparation.astc),
      imageStorageVersion: nativeAddon.assets.imageStorageVersion,
      processor: nativeAddon.assets.preparationVersion,
      tileProcessor: nativeAddon.assets.tilePreparationVersion,
      width: options.width, height: options.height,
      images: imageRecords.map(({ source, ...calculated }) => {
        const astc = astcSettings(options.assetPreparation.astc);
        const lossless = (options.assetPreparation.losslessPrefixes || []).some(prefix => source.startsWith(prefix));
        const recipe = options.assetPreparation.recipes.find(recipe => recipe.source === source || recipe.source === source.replace(/\.(png_|rpgmvp)$/i, '.png'));
        const allowAstc = astc.enabled && !lossless;
        return { source, settings: { astc, lossless, ...(recipe ? { recipe } : {}) },
          calculated: { ...calculated, resolvedSettings: { allowAstc,
            astcQuality: allowAstc ? astc.quality : null, pageCodec: options.assetPreparation.pageCodec } } };
      }), maps: maps && portableMaps(maps, includeAssets, output) };
    if (writeIndex) fs.writeFileSync(path.join(output, 'asset-index.json'), JSON.stringify(index) + '\n');
    return { images: images.total, preparedImages: images.prepared,
      maps: maps?.selected || 0, warnings: warnings.slice(0, 3), warningCount: warnings.length };
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function loadAssetIndex(file, native, options) {
  try {
    if (!file || fs.statSync(file).size > 64 * 1024 * 1024) return null;
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (![1, 2, 3].includes(index.schema) || index.kind !== 'pmjs-asset-index') return null;
    const policies = {};
    if (index.schema === 3 && Array.isArray(index.images)) {
      index.images = index.images.filter(record => record && typeof record.source === 'string').map(record => {
        policies[record.source] = record.settings || {};
        return { ...record.calculated, source: record.source };
      });
    } else {
      for (const record of Array.isArray(index.images) ? index.images : []) {
        if (!record || typeof record.source !== 'string') continue;
        policies[record.source] = {
          ...(index.astc ? { astc: index.astc } : {}),
          ...((index.losslessPrefixes || []).some(prefix => record.source.startsWith(prefix)) ? { lossless: true } : {}) };
      }
      for (const recipe of options.assetPreparation.recipes)
        policies[recipe.source] = { ...policies[recipe.source], recipe };
    }
    const legacy = index.schema === 1;
    const imageCompatible = (legacy || index.sections?.images === 1) &&
      Array.isArray(index.images) && index.images.length <= 100000 &&
      JSON.stringify(index.processor) === JSON.stringify(native.assets.preparationVersion) &&
      (index.schema === 3 || index.recipesIdentity === identity(options.assetPreparation.recipes) &&
        JSON.stringify(index.losslessPrefixes || []) === JSON.stringify(options.assetPreparation.losslessPrefixes || []) &&
        JSON.stringify(astcSettings(index.astc)) === JSON.stringify(astcSettings(options.assetPreparation.astc))) &&
      (legacy || index.pageCodec === options.assetPreparation.pageCodec) &&
      (legacy || index.pageCodec !== 'lz4' || typeof native.assets.preparationLz4Version === 'string' &&
        index.pageCodecVersion === native.assets.preparationLz4Version);
    const compilationCompatible = (legacy || index.sections?.mapCompilation === 1) &&
      index.maps?.compiler === COMPILER_VERSION;
    const tilesCompatible = (legacy || index.sections?.tileOutputs === 1) &&
      index.tileProcessor === native.assets.tilePreparationVersion &&
      index.width === options.width && index.height === options.height;
    return { ...index, policies, images: imageCompatible ? index.images.filter(record => record && typeof record.source === 'string')
        .map(record => {
          const { storage, ...rest } = record;
          if (!rest.resolvedSettings) {
            const astc = astcSettings(index.astc);
            const allowAstc = astc.enabled && !(index.losslessPrefixes || []).some(prefix => record.source.startsWith(prefix));
            rest.resolvedSettings = { allowAstc, astcQuality: allowAstc ? astc.quality : null, pageCodec: index.pageCodec || 'png' };
          }
          return index.sections?.imageStorage === 1 && index.imageStorageVersion === native.assets.imageStorageVersion &&
            index.imageStorageVersion === 1 && validStorageDecision(storage) ? { ...rest, storage } : rest;
        }) : [],
      negativeHints: !legacy && index.sections?.negativeHints === 1 &&
        Array.isArray(index.negativeHints) && index.negativeHints.length <= 100000 ? index.negativeHints : [],
      maps: compilationCompatible ? { ...index.maps,
        entries: tilesCompatible && Array.isArray(index.maps.entries) ? index.maps.entries : [] } : null };
  } catch { return null; }
}

module.exports = { generateAssetIndex, loadAssetIndex, offlineFilesystem };
