'use strict';

// A fast-boot index for prepared images. The preparation state already stores each image's
// descriptor and output hashes; what it cannot store is the VFS identity of each source and
// each page, which the native catalog install needs so it can trust the cache without opening
// 7,000 files. The catalog is written after a completed image phase and is only valid for the
// exact result set, failure set, image-source inventory, effective policy and processor it was
// written from. A stale or malformed catalog is ignored and the boot falls back to full
// validation, which rewrites it.

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const HASH = /^[a-f0-9]{64}$/;
const FILE = 'prepared-catalog.json';
const VERSION = 2;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

const isImageResult = record => record && typeof record.source === 'string' &&
  record.source.startsWith('img/') && record.descriptor && typeof record.descriptor === 'object' &&
  !Array.isArray(record.descriptor);

// Everything that determines a prepared image's outputs but is not part of the state record:
// the configured recipes/ASTC/lossless policy, the workspace budget and the asset-index file
// that supplies per-source settings. A changed value must force one full regeneration.
function policyIdentity({ recipes, astc, losslessPrefixes, workspaceBytes, pageCodec, assetIndexPath } = {}) {
  let index = null;
  if (typeof assetIndexPath === 'string' && assetIndexPath) {
    try {
      const stat = fs.statSync(assetIndexPath);
      index = [path.resolve(assetIndexPath), Number(stat.size), String(stat.mtimeMs), String(stat.ctimeMs)];
    } catch (_) {
      index = [path.resolve(assetIndexPath), null, null, null];
    }
  }
  return {
    recipes: Array.isArray(recipes) ? recipes : [],
    astc: astc === undefined ? null : astc,
    losslessPrefixes: Array.isArray(losslessPrefixes) ? losslessPrefixes : [],
    workspaceBytes: workspaceBytes === undefined ? null : workspaceBytes,
    pageCodec: pageCodec === undefined ? null : pageCodec,
    index
  };
}

function sourceSetHash(sources) {
  const hash = crypto.createHash('sha256');
  hash.update(`v${VERSION}\n`);
  for (const source of [...(sources || [])].map(String).sort()) {
    hash.update(source);
    hash.update('\0');
  }
  return hash.digest('hex');
}

// The fingerprint covers everything that determines a prepared image's outputs plus the failure
// decisions and the image-source inventory, so an added, removed or newly failing source forces
// a full phase instead of being skipped. Map results and failures do not affect it.
function fingerprint(results, failures = {}) {
  const hash = crypto.createHash('sha256');
  hash.update(`v${VERSION}\n`);
  for (const key of Object.keys(results).sort()) {
    const record = results[key];
    if (!isImageResult(record)) continue;
    const outputs = record.outputs && typeof record.outputs === 'object'
      ? Object.keys(record.outputs).sort().map(name => [name, record.outputs[name]]) : null;
    hash.update(JSON.stringify([key, record.source, record.sourceHash || '', record.descriptorHash || '',
      record.decrypted || '', outputs]));
    hash.update('\n');
  }
  for (const id of Object.keys(failures).sort()) {
    if (!id.startsWith('image:')) continue;
    hash.update(JSON.stringify([id, failures[id] ?? null]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) return null;
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function readCatalog(root) {
  try {
    const value = JSON.parse(await fsp.readFile(path.join(root, FILE), 'utf8'));
    if (!value || value.version !== VERSION || typeof value.fingerprint !== 'string' ||
        typeof value.sources !== 'string' || !value.policy || typeof value.policy !== 'object' ||
        !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries) ||
        !value.processor || typeof value.processor !== 'object') return null;
    return value;
  } catch (_) {
    return null;
  }
}

// Only entries the native install accepted have captured page identities, so a rejected image
// simply has no catalog record and uses ordinary loading. Images are never dropped silently:
// the fingerprint still covers the result, and a failed result disables the fast path.
async function writeCatalog({ root, results, failures = {}, sources, entries, processor, policy }) {
  const bySource = new Map();
  for (const entry of entries || []) {
    if (!entry || typeof entry.source !== 'string' || typeof entry.sourceIdentity !== 'string' ||
        !entry.sourceIdentity || !Array.isArray(entry.pageIdentities) ||
        entry.pageIdentities.some(identity => typeof identity !== 'string' || !identity)) continue;
    const directory = path.relative(root, entry.directory);
    if (!inside(root, directory)) continue;
    bySource.set(entry.source, {
      directory: directory.split(path.sep).join('/'),
      sourceIdentity: entry.sourceIdentity,
      pageIdentities: entry.pageIdentities.slice()
    });
  }
  const catalog = {
    version: VERSION,
    processor,
    policy,
    fingerprint: fingerprint(results, failures),
    sources: sourceSetHash(sources),
    entries: Object.fromEntries([...bySource].sort((left, right) => left[0].localeCompare(right[0])))
  };
  const file = path.join(root, FILE);
  const temporary = file + '.stage-' + crypto.randomBytes(6).toString('hex');
  try {
    await fsp.writeFile(temporary, JSON.stringify(catalog));
    await fsp.rename(temporary, file);
    return true;
  } catch (_) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

// Build the entries installPreparedCatalog() expects without touching the game tree. Returns null
// when the catalog cannot be trusted, so the caller runs the full validation and rewrites it.
function buildEntries({ root, results, failures = {}, sources, catalog, processor, policy }) {
  if (!catalog || catalog.version !== VERSION || !processor || processor.version == null ||
      JSON.stringify(catalog.processor.version) !== JSON.stringify(processor.version) ||
      catalog.processor.codec !== processor.codec ||
      (catalog.processor.lz4 || null) !== (processor.lz4 || null)) return null;
  if (!policy || JSON.stringify(catalog.policy) !== JSON.stringify(policy)) return null;
  if (catalog.sources !== sourceSetHash(sources)) return null;
  if (catalog.fingerprint !== fingerprint(results, failures)) return null;
  const entries = [];
  for (const [key, record] of Object.entries(results)) {
    if (!isImageResult(record)) continue;
    if (record.failed) return null;
    const saved = catalog.entries[record.source];
    if (!saved) continue;
    const pages = Array.isArray(record.descriptor.pages) ? record.descriptor.pages : [];
    if (!Array.isArray(saved.pageIdentities) || saved.pageIdentities.length !== pages.length ||
        saved.pageIdentities.some(identity => typeof identity !== 'string' || !identity)) return null;
    const pageHashes = pages.map(page => record.outputs?.[page.path]);
    const backingHash = record.decrypted ? record.outputs?.[record.decrypted] : record.sourceHash;
    if (typeof backingHash !== 'string' || !HASH.test(backingHash) ||
        pageHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))) return null;
    const directory = inside(root, saved.directory);
    if (!directory) return null;
    entries.push({
      source: record.source,
      directory,
      descriptor: record.descriptor,
      sourceHash: record.sourceHash,
      sourceIdentity: saved.sourceIdentity,
      backingHash,
      pageHashes,
      pageIdentities: saved.pageIdentities.slice()
    });
  }
  return entries.length ? entries : null;
}

module.exports = { FILE, VERSION, fingerprint, policyIdentity, sourceSetHash, readCatalog, writeCatalog, buildEntries };
