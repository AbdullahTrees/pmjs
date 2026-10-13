'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareAssets, validDescriptor } = require('./asset-preparation.cjs');
const { prepareMaps, validTileDescriptor } = require('./map-preparation.cjs');
const { COMPILER_VERSION } = require('./map-demand.cjs');
const { resolveDefaults } = require('./index.cjs');

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
    sourceIdentity: logical => {
      if (!exists(logical)) return null;
      const stat = fs.statSync(file(logical));
      return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    }
  };
  const game = {
    exists,
    readBytes: logical => exists(logical) ? fs.readFileSync(file(logical)) : null,
    readDirectory: logical => fs.existsSync(file(logical)) ? fs.readdirSync(file(logical)) : null
  };
  return { assets, fs: game };
}

function portableMaps(result, cacheRoot, includeAssets, output) {
  const mapInputs = Object.fromEntries(Object.entries(result.mapInputs || {}).map(([name, entry]) =>
    [name, { ...entry, dependencies: entry.dependencies.map(({ logical, hash }) => ({ logical, hash })) }]));
  const entries = [];
  for (const [mapId, selected] of Object.entries(result.index)) {
    const directory = path.join(cacheRoot, 'maps/entries', selected.identity);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
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

async function generateAssetIndex({ root, gameRoot, config, output, includeAssets, shouldCancel = () => false }) {
  const nativeAddon = require(path.join(root, 'lib/pmjs_native.node'));
  const options = resolveDefaults({ gameRoot, config });
  const cacheRoot = path.join(output, '.preparation');
  if (!options.assetPreparation.enabled) {
    const empty = { schema: 1, kind: 'pmjs-asset-index',
      processor: nativeAddon.assets.preparationVersion,
      tileProcessor: nativeAddon.assets.tilePreparationVersion,
      configSha256: config ? hash(config) : null, width: options.width, height: options.height,
      recipesIdentity: identity(options.assetPreparation.recipes), images: [], maps: null };
    fs.writeFileSync(path.join(output, 'asset-index.json'), JSON.stringify(empty) + '\n');
    return { images: 0, preparedImages: 0, maps: 0, warnings: [], warningCount: 0 };
  }
  const derived = new Map();
  const filesystem = offlineFilesystem(gameRoot, derived);
  const native = { assets: Object.assign(Object.create(nativeAddon.assets), filesystem.assets), fs: filesystem.fs };
  const warnings = [];
  const logger = { warn: message => warnings.push(message) };
  try {
    const images = await prepareAssets({ gameRoot, cacheRoot, native,
      recipes: options.assetPreparation.recipes, preparationContext: 'offline',
      verifyHashes: true, logger, shouldCancel });
    if (images.cancelled) throw new Error('image preparation cancelled');
    if (images.error) warnings.push('[pmjs] image index incomplete: ' + images.error);
    for (const entry of images.decryptedEntries) derived.set(entry.logicalSource, entry.file);
    const hasMaps = fs.existsSync(path.join(gameRoot, 'data')) &&
      fs.readdirSync(path.join(gameRoot, 'data')).some(name => /^Map\d+\.json$/i.test(name));
    let maps = options.assetPreparation.maps && hasMaps ?
      await prepareMaps({ gameRoot, cacheRoot, native, width: options.width, height: options.height,
        preparationContext: 'offline', verifyHashes: true, logger, shouldCancel }) : null;
    if (maps?.cancelled) throw new Error('map preparation cancelled');
    if (maps?.error) {
      warnings.push('[pmjs] map index unavailable: ' + maps.error);
      maps = null;
    }
    const imageRecords = images.decisions.map(decision => {
      if (decision.descriptor && !validDescriptor(decision.descriptor)) throw new Error('invalid generated image descriptor');
      const outputs = Object.entries(decision.outputs).map(([name, checksum]) => {
        const entry = images.entries.find(value => value.source === decision.source ||
          value.source === decision.source.replace(/\.(png_|rpgmvp)$/i, '.png'));
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
      return { ...decision, outputs };
    });
    const index = { schema: 1, kind: 'pmjs-asset-index',
      processor: nativeAddon.assets.preparationVersion,
      tileProcessor: nativeAddon.assets.tilePreparationVersion,
      configSha256: config ? hash(config) : null, width: options.width, height: options.height,
      recipesIdentity: identity(options.assetPreparation.recipes),
      images: imageRecords, maps: maps && portableMaps(maps, cacheRoot, includeAssets, output) };
    fs.writeFileSync(path.join(output, 'asset-index.json'), JSON.stringify(index) + '\n');
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
    if (index.schema !== 1 || index.kind !== 'pmjs-asset-index' ||
        JSON.stringify(index.processor) !== JSON.stringify(native.assets.preparationVersion) ||
        index.tileProcessor !== native.assets.tilePreparationVersion ||
        index.configSha256 !== (options.config ? hash(options.config) : null) ||
        index.width !== options.width || index.height !== options.height ||
        index.recipesIdentity !== identity(options.assetPreparation.recipes) ||
        !Array.isArray(index.images) || index.images.length > 100000) return null;
    return index;
  } catch { return null; }
}

module.exports = { generateAssetIndex, loadAssetIndex };
