'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { pipeline } = require('node:stream/promises');
const { preparationFiles, writeJson } = require('./preparation-files.cjs');
const { acquireLock, createLease, retainLeases } = require('./preparation-lifetime.cjs');
const { catalogInvalidator, readCatalog, publishCatalog, retainedCatalogKeys } = require('./preparation-catalog.cjs');

const CACHE_VERSION = 1;
const PROCESSOR_IDENTITY = { processor: 'images-v10-astc4x4-optional-astcenc4.7', decoder: 'png-rgba-v1', pageSize: 2048 };
const HASH = /^[a-f0-9]{64}$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ENCRYPTED_HEADER = Buffer.from('5250474d560000000003010000000000', 'hex');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function identity(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function validLosslessPrefixes(value = []) {
  if (!Array.isArray(value) || value.some(prefix => {
    if (typeof prefix !== 'string' || !prefix.startsWith('img/') || prefix.includes('\\') || prefix.includes('\0')) return true;
    const parts = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix).split('/');
    return parts.some(part => !part || part === '.' || part === '..');
  })) throw new Error('assetPreparation.losslessPrefixes must contain safe image path prefixes');
  return value.slice();
}
function astcSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
      (value.quality !== undefined && !['fast', 'medium', 'thorough'].includes(value.quality)))
    throw new Error('assetPreparation.astc requires a boolean enabled and quality fast, medium or thorough');
  return { enabled: value.enabled ?? false, quality: value.quality ?? 'medium' };
}
function safeSource(source) {
  return typeof source === 'string' && source.startsWith('img/') &&
    !source.includes('\\') && !source.includes('\0') &&
    source.split('/').every(part => part && part !== '.' && part !== '..') && /\.png$/i.test(source);
}
function decryptedSource(source) {
  if (typeof source !== 'string' || source.includes('\\') || source.includes('\0') ||
      !source.split('/').every(part => part && part !== '.' && part !== '..')) return null;
  const image = source.match(/^(img\/.+)\.(png_|rpgmvp)$/i);
  if (image) return image[2].endsWith('_') ? source.slice(0, -1) : image[1] + '.png';
  const audio = source.match(/^(audio\/.+)\.(ogg_|m4a_|rpgmvo|rpgmvm)$/i);
  if (!audio) return null;
  if (audio[2].endsWith('_')) return source.slice(0, -1);
  return audio[1] + (audio[2].toLowerCase() === 'rpgmvo' ? '.ogg' : '.m4a');
}
function sourceFile(native, gameRoot, source) {
  if (typeof native.assets.sourcePath === 'function') {
    const file = native.assets.sourcePath(source);
    if (!file) throw new Error('source is unavailable');
    return file;
  }
  return path.join(gameRoot, source);
}
async function encryptionSettings(native, gameRoot) {
  try {
    const file = sourceFile(native, gameRoot, 'data/System.json');
    if (!fs.existsSync(file)) return { images: false, audio: false, key: null };
    let sourceIdentity = native.assets.sourceIdentity?.('data/System.json');
    const read = () => native.fs?.readBytes ? Buffer.from(native.fs.readBytes('data/System.json')) : fsp.readFile(file);
    const data = await read();
    const current = native.assets.sourceIdentity?.('data/System.json');
    if (sourceIdentity !== undefined && current !== sourceIdentity) {
      if (!(await read()).equals(data) || native.assets.sourceIdentity('data/System.json') !== current)
        throw new Error('encryption settings changed while reading');
      sourceIdentity = current;
    }
    const system = JSON.parse(data);
    return { images: system.hasEncryptedImages === true, audio: system.hasEncryptedAudio === true,
      key: /^[a-f0-9]{32}$/i.test(system.encryptionKey) ? Buffer.from(system.encryptionKey, 'hex') : null,
      hash: crypto.createHash('sha256').update(data).digest('hex'), sourceIdentity };
  } catch (_) { return { images: false, audio: false, key: null }; }
}
function mediaHeader(bytes, extension) {
  if (extension === '.png') return bytes.subarray(0, 8).equals(PNG);
  if (extension === '.ogg') return bytes.subarray(0, 4).toString() === 'OggS' ||
    (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE');
  return extension === '.m4a' && bytes.subarray(4, 8).toString() === 'ftyp';
}
function pageHeaderMatches(header, page, size) {
  if (page.path.endsWith('.astc')) {
    const dimension = offset => header.readUIntLE(offset, 3);
    return header.length >= 16 && header.readUInt32LE(0) === 0x5ca1ab13 &&
      header[4] === 4 && header[5] === 4 && header[6] === 1 && dimension(7) === page.width &&
      dimension(10) === page.height && dimension(13) === 1 &&
      size === 16 + Math.ceil(page.width / 4) * Math.ceil(page.height / 4) * 16;
  }
  if (page.path.endsWith('.pml4')) {
    return header.length >= 32 && header.toString('ascii', 0, 4) === 'PML4' && header.readUInt32LE(4) === 1 &&
      header.readUInt32LE(8) === page.width && header.readUInt32LE(12) === page.height &&
      header.readUInt32LE(16) === page.width * page.height * 4 &&
      header.readUInt32LE(20) > 0 && header.readUInt32LE(20) === size - 32;
  }
  return header.length >= 24 && header.subarray(0, 8).equals(PNG) &&
    header.readUInt32BE(16) === page.width && header.readUInt32BE(20) === page.height;
}
async function decryptFile(file, output, key, extension) {
  const handle = await fsp.open(file, 'r');
  const prefix = Buffer.alloc(32);
  try { if ((await handle.read(prefix, 0, 32, 0)).bytesRead !== 32) throw new Error('encrypted asset is truncated'); }
  finally { await handle.close(); }
  if (!prefix.subarray(0, 16).equals(ENCRYPTED_HEADER)) throw new Error('invalid encrypted asset header');
  const body = prefix.subarray(16);
  for (let i = 0; i < 16; ++i) body[i] ^= key[i];
  if (!mediaHeader(body, extension)) throw new Error('decrypted media signature does not match encryption settings');
  await fsp.writeFile(output, body, { flag: 'wx' });
  await pipeline(fs.createReadStream(file, { start: 32 }), fs.createWriteStream(output, { flags: 'a' }));
}
async function automaticRecipe(file, source, sourceHash, header) {
  let grid;
  const filenameGrid = path.basename(source).match(/\[([1-9]\d*)x([1-9]\d*)\]\.png$/i);
  if (filenameGrid) {
    grid = filenameGrid.slice(1).map(Number);
    if (!grid.every(Number.isSafeInteger) || grid[0] > 4096 / grid[1]) return undefined;
  } else if (source.startsWith('img/sv_actors/')) grid = [9, 6];
  else if (source.startsWith('img/characters/')) {
    grid = /^[!$]*\$/.test(path.basename(source)) ? [3, 4] : [12, 8];
  }
  if (!grid && !source.startsWith('img/parallaxes/')) return undefined;
  if (!header) {
    const handle = await fsp.open(file, 'r');
    header = Buffer.alloc(24);
    try { if ((await handle.read(header, 0, 24, 0)).bytesRead !== 24) return undefined; }
    finally { await handle.close(); }
  }
  if (!grid && header.length >= 24 && header.subarray(0, 8).equals(PNG)) {
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (width >= 2048 && height >= 2048) {
      const divisions = extent => {
        for (let count = Math.ceil(extent / 1536); count <= extent; ++count)
          if (extent % count === 0) return count;
        return null;
      };
      const columns = divisions(width), rows = divisions(height);
      if (columns && rows && columns * rows <= 4096) grid = [columns, rows];
    }
  }
  if (!grid) return undefined;
  if (header.length >= 24 && header.subarray(0, 8).equals(PNG) && header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0 &&
      header.readUInt32BE(16) % grid[0] === 0 &&
      header.readUInt32BE(20) % grid[1] === 0) return { source, sourceHash, grid };
}
function validRecipes(value) {
  if (!Array.isArray(value)) throw new Error('asset recipes must be an array');
  const sources = new Set();
  for (const recipe of value) {
    if (!recipe || !safeSource(recipe.source) || !HASH.test(recipe.sourceHash) || sources.has(recipe.source)) {
      throw new Error('asset recipes require unique safe image paths and SHA-256 sourceHash');
    }
    sources.add(recipe.source);
    if (!Array.isArray(recipe.grid) || recipe.grid.length !== 2 ||
        !recipe.grid.every(n => Number.isSafeInteger(n) && n > 0) || recipe.grid[0] * recipe.grid[1] > 4096) {
      throw new Error(`invalid asset recipe grid: ${recipe.source}`);
    }
    if (recipe.crop !== undefined && (!Array.isArray(recipe.crop) || recipe.crop.length !== 4 ||
        !recipe.crop.every(n => Number.isSafeInteger(n) && n >= 0) || !recipe.crop[2] || !recipe.crop[3])) {
      throw new Error(`invalid asset recipe crop: ${recipe.source}`);
    }
    if (recipe.backdrop !== undefined && !rgba(recipe.backdrop)) throw new Error(`invalid asset recipe backdrop: ${recipe.source}`);
  }
  return value;
}
function rgba(value) {
  return Array.isArray(value) && value.length === 4 && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
}
function rect(value, positive = true) {
  return Array.isArray(value) && value.length === 4 && value.every(n => Number.isSafeInteger(n) && n >= 0) &&
    (positive ? value[2] > 0 && value[3] > 0 : true);
}
function validStorageDecision(value) {
  return value && value.version === 1 &&
    [value.width, value.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192) &&
    [0, 8, 16].includes(value.paletteBits) && [1, 2, 4].includes(value.channels) &&
    Array.isArray(value.source) && value.source.length === 4 &&
    value.source.every(n => Number.isInteger(n) && n >= 0 && n < 4) &&
    Array.isArray(value.swizzle) && value.swizzle.length === 4 &&
    value.swizzle.every(n => Number.isInteger(n) && (n >= 0 && n < value.channels || n === 4 || n === 5)) &&
    (!value.paletteBits || value.channels === 4 && value.width >= 2048 && value.height >= 2048);
}

function validDescriptor(d) {
  if (!d || d.version !== 1 || !Number.isSafeInteger(d.width) || !Number.isSafeInteger(d.height) ||
      d.width < 1 || d.height < 1 || !Array.isArray(d.pages) || !Array.isArray(d.cells) || d.pages.length > 4096 || d.cells.length > 4096) return false;
  if (d.compression !== undefined) {
    return d.compression === 'astc-4x4' && d.width <= 8192 && d.height <= 8192 &&
      d.width * d.height <= 32 * 1024 * 1024 && d.halo === 1 && d.uniform === undefined &&
      d.blockGrid === undefined && d.cells.length === 0 && [1, 2].includes(d.pages.length) &&
      d.pages.every((p, i) => p && p.path === `page-${i}.astc` && p.width === d.width && p.height === d.height);
  }
  if (d.uniform !== undefined && !rgba(d.uniform)) return false;
  if (d.halo !== undefined && (!Number.isInteger(d.halo) || d.halo < 1 || d.halo > 2048)) return false;
  if (d.blockGrid !== undefined) {
    const g = d.blockGrid;
    if (d.uniform !== undefined || !Array.isArray(g) || g.length !== 3 || g[0] !== 64 ||
        !g.every(n => Number.isSafeInteger(n) && n > 0) || d.width % g[1] || d.height % g[2] ||
        Math.ceil(g[1] / 64) * Math.ceil(g[2] / 64) * (d.width / g[1]) * (d.height / g[2]) > 65536) return false;
  }
  if (d.pages.some(p => !p || !/^page-\d+\.(png|pml4|astc)$/.test(p.path) || !Number.isInteger(p.width) ||
      !Number.isInteger(p.height) || p.width < 1 || p.height < 1 || p.width > 2048 || p.height > 2048)) return false;
  if (new Set(d.pages.map(p => p.path)).size !== d.pages.length) return false;
  let area = 0;
  for (let i = 0; i < d.cells.length; ++i) {
    const c = d.cells[i];
    if (!c || !rect(c.rect) || !rect(c.crop, false) || !rgba(c.fill) ||
        ((c.crop[2] === 0) !== (c.crop[3] === 0)) ||
        c.rect[0] + c.rect[2] > d.width || c.rect[1] + c.rect[3] > d.height ||
        c.crop[0] + c.crop[2] > c.rect[2] || c.crop[1] + c.crop[3] > c.rect[3]) return false;
    if (d.blockGrid) {
      const [, fw, fh] = d.blockGrid;
      const [x, y, w, h] = c.rect, lx = x % fw, ly = y % fh;
      if (lx + w > fw || ly + h > fh || lx % 64 || ly % 64 ||
          ((lx + w) % 64 && lx + w !== fw) || ((ly + h) % 64 && ly + h !== fh) ||
          (c.crop[2] && (w !== Math.min(64, fw - lx) || h !== Math.min(64, fh - ly) ||
            c.crop[0] !== 0 || c.crop[1] !== 0 || c.crop[2] !== w || c.crop[3] !== h))) return false;
    }
    if (c.crop[2] && c.crop[3]) {
      const page = d.pages[c.page];
      if (!Number.isInteger(c.page) || !page || !rect(c.atlas) ||
          c.atlas[2] !== c.crop[2] || c.atlas[3] !== c.crop[3] ||
          c.atlas[0] + c.atlas[2] > page.width || c.atlas[1] + c.atlas[3] > page.height ||
          (d.halo !== undefined && (c.atlas[0] < d.halo || c.atlas[1] < d.halo ||
            c.atlas[0] + c.atlas[2] + d.halo > page.width || c.atlas[1] + c.atlas[3] + d.halo > page.height))) return false;
    }
    for (let j = 0; j < i; ++j) {
      const other = d.cells[j].rect;
      if (c.rect[0] < other[0] + other[2] && other[0] < c.rect[0] + c.rect[2] &&
          c.rect[1] < other[1] + other[3] && other[1] < c.rect[1] + c.rect[3]) return false;
    }
    area += c.rect[2] * c.rect[3];
  }
  return area === d.width * d.height || (d.uniform !== undefined && d.cells.length === 0 && d.pages.length === 0);
}
async function discover(gameRoot, cacheRoot) {
  const result = [];
  const root = await fsp.realpath(gameRoot);
  const entryDirectory = path.resolve(cacheRoot, 'entries');
  const ownedEntries = await fsp.realpath(entryDirectory).catch(() => entryDirectory);
  async function visit(relative) {
    const directory = path.join(root, relative);
    if (directory === ownedEntries) return;
    let files;
    try { files = await fsp.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative + '/' + entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile() && (safeSource(name) || decryptedSource(name))) result.push(name);
    }
  }
  await visit('img');
  await visit('audio');
  return result;
}
async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return null; }
}

const installedLeases = new WeakMap();

async function createImageLease(cacheRoot, keys, assets) {
  const releaseLease = await createLease(cacheRoot, keys);
  function release() {
    releaseLease();
    if (installedLeases.get(assets) === release) installedLeases.delete(assets);
  }
  return release;
}
async function cachedEntry(directory, key, sourceHash, files) {
  try {
    return await files.validatedJson(path.join(directory, 'manifest.json'), async (manifest, reused) => {
      if (!manifest || manifest.version !== CACHE_VERSION || manifest.key !== key || manifest.sourceHash !== sourceHash ||
          manifest.descriptorHash !== identity(manifest.descriptor)) return false;
      if (manifest.decrypted !== undefined && !/^source\.(png|ogg|m4a)$/.test(manifest.decrypted)) return false;
      if (manifest.descriptor !== null && !validDescriptor(manifest.descriptor)) return false;
      const pages = manifest.descriptor ? manifest.descriptor.pages : [];
      if (!manifest.outputs || Object.keys(manifest.outputs).length !== pages.length + (manifest.decrypted ? 1 : 0)) return false;
      const outputs = [...pages, ...(manifest.decrypted ? [{ path: manifest.decrypted }] : [])];
      for (const page of outputs) {
        const file = path.join(directory, page.path);
        if (!HASH.test(manifest.outputs[page.path])) return false;
        const checked = await files.inspect(file, 'output');
        if (checked.hash !== manifest.outputs[page.path]) return false;
        if (reused && checked.reused) continue;
        let header = checked.header;
        if (!header) {
          const handle = await fsp.open(file, 'r');
          header = Buffer.alloc(page.path.endsWith('.pml4') ? 32 : 24);
          try { if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) return false; }
          finally { await handle.close(); }
        }
        if (page.path === manifest.decrypted) {
          if (!mediaHeader(header, path.extname(page.path))) return false;
        } else if (!pageHeaderMatches(header, page, checked.size)) return false;
      }
      return true;
    });
  } catch (_) { return null; }
}

async function prepareAssets({ gameRoot, cacheRoot, recipes = [], native, onProgress = () => {},
  shouldCancel = () => false, logger = console, verifyHashes = false,
  workspaceBytes = 256 * 1024 * 1024,
  pageCodec = 'lz4',
  losslessPrefixes = [],
  astc,
  preparationContext = 'live',
  portableIndex = null, portableAssetRoot = null,
  processorIdentity = (native && native.assets && native.assets.preparationVersion) || PROCESSOR_IDENTITY }) {
  losslessPrefixes = validLosslessPrefixes(losslessPrefixes);
  astc = astcSettings(astc);
  if (!['live', 'offline'].includes(preparationContext)) throw new Error('invalid preparation context');
  if (!['png', 'lz4'].includes(pageCodec)) throw new Error('assetPreparation.pageCodec must be png or lz4');
  if (!Number.isSafeInteger(workspaceBytes) || workspaceBytes < 0 || workspaceBytes > 256 * 1024 * 1024)
    throw new Error('assetPreparation.workspaceBytes must be an integer from 0 to 268435456');
  const offline = preparationContext === 'offline';
  const audioViewSupport = !offline && typeof native?.media?.installAudioViews === 'function';
  const audioSettings = audioViewSupport ? await encryptionSettings(native, gameRoot) : null;
  const negativeHints = new Set((portableIndex?.negativeHints || []).filter(source =>
    safeSource(source) && source.endsWith('.png')));
  const indexedImages = new Map();
  for (const record of portableIndex?.images || []) {
    const records = indexedImages.get(record.source);
    if (records) records.push(record);
    else indexedImages.set(record.source, [record]);
  }
  const started = performance.now();
  const result = { enabled: true, total: 0, completed: 0, generated: 0, hits: 0, negativeHits: 0,
    fallback: 0, failedFiles: 0, installFailures: 0, prepared: 0, installed: 0, decrypted: 0, sourceBytes: 0, cacheBytes: 0,
    indexedNegative: 0, indexedLayoutAttempts: 0, indexedZeroPage: 0,
    indexedPageCopies: 0, unindexedProcessed: 0, processingMs: 0,
    cancelled: false, entries: [], decryptedEntries: [], audioViewEntries: [], audioViews: 0, decisions: [], storageEntries: [], durationMs: 0 };
  const catalogFile = path.join(cacheRoot, 'catalog-'+identity(path.resolve(gameRoot))+'.json');
  result.invalidateCatalog = catalogInvalidator(catalogFile, logger);
  let release;
  let catalogNegativeHits = 0;
  let indexedNegativeSkips = 0;
  let terminalPhase = 'complete';
  const report = (phase, source = '', terminal = false) => onProgress({
    phase, source, terminal, completed: result.completed, total: result.total,
    remaining: result.total - result.completed, generated: result.generated, hits: result.hits,
    fallback: result.fallback, sourceBytes: result.sourceBytes, elapsedMs: performance.now() - started
  });
  async function clearIndexes() {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => native.assets.installPrepared([])),
      Promise.resolve().then(() => native.assets.installImageStorage?.([])),
      Promise.resolve().then(() => native.assets.installDecrypted?.([])),
      Promise.resolve().then(() => native.media?.installAudioViews?.([]))
    ]);
    for (const value of results) if (value.status === 'rejected')
      logger.warn('[pmjs] cannot clear preparation index: '+value.reason.message);
  }
  const cancelled = () => { if (shouldCancel()) result.cancelled = true; return result.cancelled; };
  try {
    report('discover');
    if (cancelled()) return result;
    validRecipes(recipes);
    if (pageCodec === 'lz4') {
      if (native.assets?.preparationWorkspaceVersion !== 1 || typeof native.assets?.preparationLz4Version !== 'string')
        throw new Error('LZ4 image preparation is unavailable in this addon');
      processorIdentity = { ...processorIdentity, pageCodec: native.assets.preparationLz4Version };
    }
    if (!native.assets || typeof native.assets.processImage !== 'function' ||
        (!offline && typeof native.assets.installPrepared !== 'function')) {
      throw new Error('image preparation is unavailable in this addon');
    }

    const storageRecords = (portableIndex?.images || []).filter(record => validStorageDecision(record.storage));
    const binding = { gameRoot: path.resolve(gameRoot), cacheRoot: path.resolve(cacheRoot), processorIdentity, recipes, losslessPrefixes, astc,
      ...(storageRecords.length ? { imageStorage: identity(storageRecords
        .map(record => [record.source, record.sourceHash, record.storage])) } : {}),
      contentIdentity: 1, ...(audioViewSupport ? { audioViewVersion: 1, audioSettingsHash: audioSettings.hash || null } : {}) };
    const catalogCapable = typeof native.assets.installPreparedCatalog === 'function' &&
      typeof native.assets.installDerivedCatalog === 'function';
    result.catalogStatus = offline ? 'offline' : verifyHashes ? 'verify-hashes' :
      catalogCapable ? 'checking' : 'unsupported';
    if (!offline && !verifyHashes && catalogCapable) {
      await fsp.mkdir(cacheRoot, { recursive: true });
      report('wait');
      release = await acquireLock(cacheRoot, cancelled, () => report('wait'), native.assets);
      if (!release) return result;
      report('catalog');
      const catalog = await readCatalog(catalogFile, binding, cacheRoot, reason => { result.catalogStatus = reason; });
      if (catalog && !cancelled()) {
        let lease;
        try {
          report('install');
          lease = await createImageLease(cacheRoot, catalog.keys, native.assets);
          await native.assets.installDerivedCatalog(catalog.decryptedEntries);
          if (audioViewSupport && native.media.installAudioViews(catalog.audioViewEntries || []) !== (catalog.audioViewEntries || []).length)
            throw new Error('incomplete audio view installation');
          if (audioViewSupport && (await encryptionSettings(native, gameRoot)).hash !== audioSettings.hash)
            throw new Error('audio encryption settings changed during preparation');
          const storageEntries = catalog.storageEntries || [];
          if ((await native.assets.installImageStorage?.(storageEntries) || 0) !== storageEntries.length)
            throw new Error('incomplete image storage catalog installation');
          const installed = await native.assets.installPreparedCatalog(catalog.entries);
          if (installed !== catalog.entries.length) throw new Error('incomplete image catalog installation');
          if (cancelled()) throw new Error('catalog installation cancelled');
          const previous = installedLeases.get(native.assets);
          installedLeases.set(native.assets, lease);
          if (previous) previous();
          Object.assign(result, catalog.summary, { entries: catalog.entries, storageEntries, decryptedEntries: catalog.decryptedEntries,
            audioViewEntries: catalog.audioViewEntries || [],
            generated: 0, failedFiles: 0, installFailures: 0, catalogHit: true, catalogStatus: 'hit', releaseCacheLease: lease });
          report('install');
          return result;
        } catch (error) {
          result.catalogStatus = 'install-rejected';
          result.catalogError = error.message;
          if (lease) lease();
          await clearIndexes();
        }
      }
      await release(); release = undefined;
      if (cancelled()) return result;
    }
    report('discover');
    const sources = await discover(gameRoot, cacheRoot);
    const settings = await encryptionSettings(native, gameRoot);
    result.total = sources.length;
    report('discover');
    if (cancelled()) return result;
    if (!sources.length) {
      report('install');
      if (cancelled()) return result;
      if (!offline) {
        await native.assets.installPrepared([]);
        if (native.assets.installDecrypted) await native.assets.installDecrypted([]);
        if (audioViewSupport) native.media.installAudioViews([]);
      }
      return result;
    }
    await fsp.mkdir(path.join(cacheRoot, 'entries'), { recursive: true });
    report('wait');
    release = await acquireLock(cacheRoot, cancelled, () => report('wait'), native.assets);
    if (!release) return result;
    report('validate');
    const files = await preparationFiles(cacheRoot, verifyHashes);
    result.validation = files.stats;
    async function refreshIdentity(source, expectedHash, previous) {
      const current = native.assets.sourceIdentity?.(source);
      if (current === undefined || current === previous) return current;
      const file = sourceFile(native, gameRoot, source);
      if (await files.hash(file) !== expectedHash || native.assets.sourceIdentity(source) !== current)
        throw new Error('source changed while validating '+source);
      return current;
    }
    const indexName = 'index-' + identity(path.resolve(gameRoot)) + '.json';
    const recipeMap = new Map(recipes.map(recipe => [recipe.source, recipe]));
    const keys = [];
    for (const source of sources) {
      if (cancelled()) break;
      report('validate', source);
      let stage;
      let sourcePhase = 'validate';
      try {
        const decryptedPath = decryptedSource(source);
        const encrypted = decryptedPath !== null;
        const logicalSource = decryptedPath || source;
        const extension = path.extname(logicalSource).toLowerCase();
        const audioView = audioViewSupport && encrypted && source.startsWith('audio/');
        if (encrypted && (!settings.key || !(extension === '.png' ? settings.images : settings.audio) ||
            (!offline && !audioView && typeof native.assets.installDecrypted !== 'function'))) throw new Error('cached decryption is unavailable');
        if (encrypted && !audioView && fs.existsSync(path.join(gameRoot, logicalSource))) throw new Error('plaintext source path already exists');
        const file = sourceFile(native, gameRoot, source);
        if (audioView) {
          const size = (await fsp.stat(file)).size;
          result.audioViewEntries.push({ source, logicalSource, key: settings.key.toString('hex') });
          result.sourceBytes += size;
          result.completed += 1;
          report('audio-view', source);
          continue;
        }
        let sourceIdentity = typeof native.assets.sourceIdentity === 'function' ? native.assets.sourceIdentity(source) : undefined;
        const hintedNegative = !offline && !verifyHashes && !encrypted && extension === '.png' &&
          !recipeMap.has(logicalSource) && negativeHints.has(source) &&
          !indexedImages.get(source)?.some(record => validStorageDecision(record.storage));
        const checkedSource = hintedNegative ? { hash: null, size: 0 } : await files.inspect(file, 'source');
        const sourceHash = checkedSource.hash;
        if (sourceIdentity !== undefined && native.assets.sourceIdentity(source) !== sourceIdentity) throw new Error('source changed while hashing');
        result.sourceBytes += checkedSource.size;
        let recipe = recipeMap.get(logicalSource);
        if (!recipe && !encrypted && !hintedNegative) recipe = await automaticRecipe(file, logicalSource, sourceHash, checkedSource.header);
        if (recipe && recipe.sourceHash !== sourceHash) throw new Error('recipe source hash changed');
        const allowAstc = astc.enabled && !losslessPrefixes.some(prefix => logicalSource.startsWith(prefix));
        const key = identity({ version: CACHE_VERSION, processorIdentity, sourceHash, source, recipe: recipe || null, allowAstc,
          astcQuality: allowAstc ? astc.quality : null,
          ...(encrypted ? { encryption: { version: 1, settingsHash: settings.hash }, characterLayout: 'mz-standard-v1' } : {}) });
        const findIndexed = () => indexedImages.get(source)?.find(record =>
          record.sourceHash === sourceHash && identity(record.recipe) === identity(recipe || null) &&
          record.encryptionSettingsSha256 === (encrypted ? settings.hash : null) &&
          (record.descriptor === null && Array.isArray(record.outputs) && !record.outputs.length ||
            record.descriptor && validDescriptor(record.descriptor)));
        let indexed = hintedNegative ? { descriptor: null } : encrypted ? null : findIndexed();
        // A matching negative decision needs no prepared backing or cache entry.
        // The ordinary loader will read the original source if it is requested.
        const indexedNegativeSkip = !offline && !encrypted && extension === '.png' && indexed?.descriptor === null;
        if (indexedNegativeSkip) {
          if (validStorageDecision(indexed.storage))
            result.storageEntries.push({ source: logicalSource, sourceIdentity, storage: indexed.storage });
          ++result.indexedNegative;
          ++result.fallback;
          ++catalogNegativeHits;
          ++indexedNegativeSkips;
        } else {
          const directory = path.join(cacheRoot, 'entries', key);
          let manifest = await cachedEntry(directory, key, sourceHash, files);
          if (manifest && encrypted && manifest.decrypted !== 'source' + extension) manifest = null;
          if (manifest) {
            result.hits += 1;
            if (!manifest.descriptor && !manifest.decrypted) result.negativeHits += 1;
          } else {
            sourcePhase = 'prepare';
            report('prepare', source);
            if (cancelled()) break;
            stage = await fsp.mkdtemp(path.join(cacheRoot, 'entries', '.stage-'));
            const decrypted = encrypted ? 'source' + extension : undefined;
            let input = file;
            if (decrypted) {
              input = path.join(stage, decrypted);
              await decryptFile(file, input, settings.key, extension);
              if (!recipe) recipe = await automaticRecipe(input, logicalSource, sourceHash);
              indexed = findIndexed();
            }
            if (cancelled()) break;
            let descriptor = null, copied = false;
            const indexedFallback = indexed?.descriptor === null;
            if (indexedFallback) ++result.indexedNegative;
            if (indexed?.descriptor && (indexed.descriptor.compression === 'astc-4x4' || indexed.descriptor.pages.every(p => p.path.endsWith(pageCodec === 'lz4' ? '.pml4' : '.png'))) &&
                portableAssetRoot && Array.isArray(indexed.outputs) &&
                indexed.outputs.length === indexed.descriptor.pages.length) {
              const pages = indexed.descriptor.pages;
              try {
                for (let i = 0; i < pages.length; ++i) {
                  const item = indexed.outputs[i];
                  if (!item || typeof item.path !== 'string' || !/^assets\/images\/[a-f0-9]{64}\/page-\d+\.(png|pml4|astc)$/.test(item.path) ||
                      path.basename(item.path) !== pages[i].path || !HASH.test(item.hash)) throw new Error('invalid indexed page');
                  const candidate = path.join(portableAssetRoot, item.path);
                  const checked = await files.copyVerified(candidate, path.join(stage, pages[i].path), item.hash);
                  if (!pageHeaderMatches(checked.header, pages[i], checked.size))
                    throw new Error('indexed page header differs');
                }
                descriptor = indexed.descriptor;
                copied = true;
                if (pages.length) ++result.indexedPageCopies;
                else ++result.indexedZeroPage;
              } catch (_) {
                for (const page of pages) await fsp.rm(path.join(stage, page.path), { force: true });
              }
            }
            if (!copied && !indexedFallback && extension === '.png') {
              if (indexed) ++result.indexedLayoutAttempts;
              else ++result.unindexedProcessed;
              const processingStarted = performance.now();
              try { descriptor = await native.assets.processImage(source, stage, recipe || null,
                input, ...(native.assets.preparationWorkspaceVersion === 1
                  ? [indexed ? indexed.descriptor : null, { workspaceBytes, allowAstc, astcQuality: astc.quality, ...(pageCodec === 'lz4' ? { pageCodec } : {}) }]
                  : indexed ? [indexed.descriptor] : [])); }
              finally { result.processingMs += performance.now() - processingStarted; }
            }
            if (cancelled()) break;
            if (descriptor?.compression && !allowAstc) throw new Error('lossless image policy forbids compressed output');
            if (descriptor !== null && !validDescriptor(descriptor)) throw new Error('processor returned invalid logical image descriptor');
            if (!descriptor?.compression && descriptor?.pages.some(p => !p.path.endsWith(pageCodec === 'lz4' ? '.pml4' : '.png')))
              throw new Error('processor returned a different page codec');
            // Ordinary boot assumes game assets remain unchanged while preparing.
            if (verifyHashes && await hashFile(file) !== sourceHash) throw new Error('source changed during image preparation');
            const outputs = {};
            if (decrypted) outputs[decrypted] = await files.hash(input);
            for (const page of descriptor ? descriptor.pages : []) outputs[page.path] = await files.hash(path.join(stage, page.path), 'output');
            manifest = { version: CACHE_VERSION, key, source, sourceHash, descriptor, descriptorHash: identity(descriptor), outputs,
              ...(decrypted ? { decrypted } : {}) };
            // Cache entries are disposable and hash-validated; locks, leases and indexes still flush.
            await writeJson(path.join(stage, 'manifest.json'), manifest, false);
            if (!await cachedEntry(stage, key, sourceHash, files)) throw new Error('prepared output validation failed');
            await fsp.rm(directory, { recursive: true, force: true });
            await fsp.rename(stage, directory);
            stage = null;
            if (!await cachedEntry(directory, key, sourceHash, files)) throw new Error('published output validation failed');
            result.generated += 1;
          }
          sourceIdentity = await refreshIdentity(source, sourceHash, sourceIdentity);
          if (validStorageDecision(indexed?.storage))
            result.storageEntries.push({ source: logicalSource, sourceIdentity, storage: indexed.storage });
          if (offline) result.decisions.push({ source, sourceHash, recipe: recipe || null,
            encryptionSettingsSha256: encrypted ? settings.hash : null,
            descriptor: manifest.descriptor, outputs: Object.fromEntries(Object.entries(manifest.outputs)
              .filter(([name]) => name !== manifest.decrypted)) });
          if (encrypted) settings.sourceIdentity = await refreshIdentity('data/System.json', settings.hash, settings.sourceIdentity);
          keys.push(key);
          if (manifest.decrypted) {
            result.decryptedEntries.push({ source, logicalSource, file: path.join(directory, manifest.decrypted),
              sourceIdentity, sourceHash, settingsIdentity: settings.sourceIdentity,
              settingsHash: settings.hash, fileHash: manifest.outputs[manifest.decrypted] });
            result.cacheBytes += (await fsp.stat(path.join(directory, manifest.decrypted))).size;
          }
          if (manifest.descriptor) {
            for (const page of manifest.descriptor.pages) result.cacheBytes += (await fsp.stat(path.join(directory, page.path))).size;
            result.entries.push({ source: logicalSource, directory, descriptor: manifest.descriptor, sourceHash, sourceIdentity,
              backingHash: manifest.decrypted ? manifest.outputs[manifest.decrypted] : sourceHash,
              pageHashes: manifest.descriptor.pages.map(page => manifest.outputs[page.path]),
              ...(encrypted ? { decryptedFile: path.join(directory, manifest.decrypted) } : {}) });
          } else if (!manifest.decrypted) { result.fallback += 1; ++catalogNegativeHits; }
        }
      } catch (error) {
        result.fallback += 1;
        result.failedFiles += 1;
        logger.warn(`[pmjs] asset preparation fallback ${source}: ${error.message}`);
      } finally {
        if (stage) await fsp.rm(stage, { recursive: true, force: true });
      }
      result.completed += 1;
      report(sourcePhase, source);
    }
    if (!cancelled()) {
      report('install');
      if (cancelled()) return result;
      if (result.decryptedEntries.length) {
        settings.sourceIdentity = await refreshIdentity('data/System.json', settings.hash, settings.sourceIdentity);
        for (const entry of result.decryptedEntries) {
          entry.sourceIdentity = await refreshIdentity(entry.source, entry.sourceHash, entry.sourceIdentity);
          entry.settingsIdentity = settings.sourceIdentity;
        }
      }
      if (offline) {
        result.prepared = result.installed = result.entries.length;
        result.decrypted = result.decryptedEntries.length;
        await files.save();
        return result;
      }
      const releaseCacheLease = await createImageLease(cacheRoot, keys, native.assets);
      const previousLease = installedLeases.get(native.assets);
      installedLeases.set(native.assets, releaseCacheLease);
      result.releaseCacheLease = releaseCacheLease;
      if (native.assets.installDecrypted) {
        await native.assets.installDecrypted(result.decryptedEntries, catalogCapable);
        result.decrypted = result.decryptedEntries.filter(entry => native.assets.hasDecrypted(entry.logicalSource)).length;
        result.installFailures += result.decryptedEntries.length - result.decrypted;
        result.fallback += result.decryptedEntries.length - result.decrypted;
        result.entries = result.entries.filter(entry => {
          if (!entry.decryptedFile) return true;
          if (!native.assets.hasDecrypted(entry.source)) return false;
          entry.sourceIdentity = native.assets.sourceIdentity(entry.source);
          if (native.assets.sourcePath(entry.source) !== entry.decryptedFile) return false;
          delete entry.decryptedFile;
          return true;
        });
      }
      if (audioViewSupport) {
        if ((await encryptionSettings(native, gameRoot)).hash !== audioSettings.hash)
          throw new Error('audio encryption settings changed during preparation');
        result.audioViews = native.media.installAudioViews(result.audioViewEntries);
        result.fallback += result.audioViewEntries.length - result.audioViews;
        result.installFailures += result.audioViewEntries.length - result.audioViews;
      }
      const decryptedSources = new Set(result.decryptedEntries.map(entry => entry.logicalSource));
      result.storageEntries = result.storageEntries.filter(entry => {
        if (!decryptedSources.has(entry.source)) return true;
        if (!native.assets.hasDecrypted(entry.source)) return false;
        entry.sourceIdentity = native.assets.sourceIdentity(entry.source);
        return true;
      });
      if ((await native.assets.installImageStorage?.(result.storageEntries) || 0) !== result.storageEntries.length)
        throw new Error('incomplete image storage installation');
      const installed = await native.assets.installPrepared(result.entries, catalogCapable);
      if (previousLease) previousLease();
      result.prepared = result.entries.length;
      result.installed = Number.isInteger(installed) ? installed : result.entries.length;
      result.fallback += result.prepared - result.installed;
      result.installFailures += result.prepared - result.installed;
      if (result.installed < result.prepared) {
        logger.warn(`[pmjs] prepared image index installed ${result.installed}/${result.prepared}; remaining images use ordinary loading`);
      }
      if (catalogCapable && result.installed === result.entries.length && result.decrypted === result.decryptedEntries.length && result.audioViews === result.audioViewEntries.length) {
        report('publish');
        const summary = Object.fromEntries(Object.entries(result).filter(([, value]) => typeof value === 'number'));
        summary.hits = keys.length + indexedNegativeSkips + result.audioViews;
        summary.negativeHits = catalogNegativeHits;
        await publishCatalog(catalogFile, binding, cacheRoot, { keys, entries: result.entries, storageEntries: result.storageEntries,
          decryptedEntries: result.decryptedEntries, audioViewEntries: result.audioViewEntries, summary });
      }
      report('cleanup');
      await files.save();
      const indexStage = path.join(cacheRoot, '.' + indexName + '-' + crypto.randomBytes(6).toString('hex'));
      await writeJson(indexStage, { version: CACHE_VERSION, keys });
      await fsp.rename(indexStage, path.join(cacheRoot, indexName));
      const retained = new Set(keys);
      for (const filename of await fsp.readdir(cacheRoot)) {
        if (!/^(index|catalog)-/.test(filename) || !filename.endsWith('.json') || filename === indexName) continue;
        const other = await readJson(path.join(cacheRoot, filename));
        for (const key of retainedCatalogKeys(other)) retained.add(key);
      }
      const mapRoot = path.join(cacheRoot, 'maps');
      for (const filename of await fsp.readdir(mapRoot).catch(() => [])) {
        if (!/^catalog-[a-f0-9]{64}\.json$/.test(filename)) continue;
        const catalog = await readJson(path.join(mapRoot, filename));
        for (const key of retainedCatalogKeys(catalog)) retained.add(key);
      }
      if (fs.existsSync(mapRoot)) await retainLeases(mapRoot, retained);
      await retainLeases(cacheRoot, retained);
      for (const name of await fsp.readdir(path.join(cacheRoot, 'entries'))) {
        if (name.startsWith('.stage-') || (HASH.test(name) && !retained.has(name))) {
          await fsp.rm(path.join(cacheRoot, 'entries', name), { recursive: true, force: true });
        }
      }
    }
  } catch (error) {
    terminalPhase = 'error';
    result.error = error.message;
    if (result.releaseCacheLease) {
      result.releaseCacheLease(); delete result.releaseCacheLease;
      await clearIndexes();
      result.installed = result.decrypted = result.audioViews = 0;
    }
    result.fallback += result.total - result.completed;
    logger.warn(`[pmjs] asset preparation unavailable: ${error.message}`);
  } finally {
    if (release) {
      try { await release(); }
      catch (error) { logger.warn(`[pmjs] cannot release asset preparation lock: ${error.message}`); }
    }
    result.durationMs = performance.now() - started;
    cancelled();
    if (result.cancelled && result.releaseCacheLease) {
      result.releaseCacheLease(); delete result.releaseCacheLease;
      await clearIndexes();
      result.installed = result.decrypted = result.audioViews = 0;
    }
    report(result.cancelled ? 'cancelled' : terminalPhase, '', true);
  }
  return result;
}

module.exports = { astcSettings, validLosslessPrefixes, prepareAssets, validRecipes, validDescriptor, validStorageDecision, automaticRecipe, PROCESSOR_IDENTITY };
