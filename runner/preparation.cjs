'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { openPreparation, inventory, invalidateResults } = require('./preparation-state.cjs');
const { prepareAssetsPhase, imageSourceList } = require('./asset-preparation.cjs');
const { prepareMapsPhase } = require('./map-preparation.cjs');
const { prepareForRun } = require('./port-preparation.cjs');
const { readCatalog, writeCatalog, buildEntries, policyIdentity } = require('./prepared-catalog.cjs');

const isImageResult = record => record && typeof record.source === 'string' &&
  record.source.startsWith('img/') && record.descriptor;

function imageProcessor(native, pageCodec) {
  return { version: native.assets?.preparationVersion ?? null,
    lz4: native.assets?.preparationLz4Version ?? null, codec: pageCodec };
}

// A verified cache can be installed from its catalog without statting or reading the game tree.
// The fingerprint ties the catalog to the exact result set, and any failed or invalidated image
// refuses the fast path so the full phase can repair it.
async function tryFastImages(options, session) {
  const { native, logger = console, pageCodec = 'lz4' } = options;
  if (options.verifyHashes) return null;
  if (!native.assets || typeof native.assets.installPreparedCatalog !== 'function') return null;
  const catalog = await readCatalog(session.root);
  if (!catalog) return null;
  const entries = buildEntries({ root: session.root, results: session.data.results,
    failures: session.data.failures, sources: imageSourceList(session.inventory), catalog,
    processor: imageProcessor(native, pageCodec), policy: policyIdentity(options) });
  if (!entries) return null;
  const started = performance.now();
  let report;
  try { report = await native.assets.installPreparedCatalog(entries, false, true); }
  catch (error) {
    logger.warn?.('[pmjs] fast image catalog install failed: ' + error.message);
    return null;
  }
  const accepted = report?.accepted ? report.accepted.length : Number.isInteger(report) ? report : entries.length;
  if (accepted !== entries.length) {
    native.assets.installPrepared?.([]);
    logger.warn?.(`[pmjs] fast image catalog installed ${accepted}/${entries.length}; using full validation`);
    return null;
  }
  const imageRecords = Object.values(session.data.results).filter(isImageResult);
  return {
    total: imageRecords.length, prepared: entries.length, installed: entries.length,
    generated: 0, hits: entries.length, fallback: imageRecords.length - entries.length,
    failedFiles: 0, decrypted: 0, storageEntries: [], decryptedEntries: [],
    audioViewEntries: [], audioViews: 0, decisions: [], entries: [],
    durationMs: performance.now() - started, fast: true
  };
}


async function prepareGameAssets(options) {
  const { native, logger = console, shouldCancel = () => false,
    onProgress = () => {}, preparationContext = 'live' } = options;
  let session;
  try { session = await openPreparation({ ...options, offline: preparationContext === 'offline' }); }
  catch (error) {
    logger.warn('[pmjs] preparation unavailable: ' + error.message);
    const discovered = await inventory(options.gameRoot, native, path.resolve(options.cacheRoot)).catch(() => []);
    const total = discovered.filter(source => /^(img\/.+\.(png|png_|rpgmvp)|audio\/.+\.(ogg_|m4a_|rpgmvo|rpgmvm))$/i.test(source)).length;
    const images = { error: error.message, entries: [], decryptedEntries: [], installed: 0, prepared: 0,
      generated: 0, hits: 0, fallback: 0, failedFiles: 0, total, completed: 0, sourceBytes: 0, durationMs: 0 };
    onProgress({ ...images, stage: 'images', phase: 'discover', source: '', remaining: total, elapsedMs: 0 });
    onProgress({ ...images, stage: 'images', phase: 'error', source: '', remaining: total, elapsedMs: 0, terminal: true });
    return { portArtifacts: new Map(), images };
  }
  if (!session) return { cancelled: true, images: { cancelled: true }, portArtifacts: new Map() };
  const result = { cancelled: false, root: session.root, portArtifacts: new Map() };
  const phase = async (name, run) => {
    session.startPhase(name);
    onProgress({ stage: name, phase: 'start', source: '', completed: 0, total: 0 });
    let value;
    try {
      for (let attempt = 0; attempt < 2; ++attempt) {
        value = await run(progress => onProgress({ ...progress, stage: name }));
        const rejected = value?.activation?.rejected || [];
        for (const item of rejected) {
          logger.warn(`[pmjs] preparation ${name}/${item.id}: ${item.reason}; using original if repair fails`);
          session.repairSources.add(item.id);
          const encryptedSource = value.decryptedEntries?.find(entry => entry.logicalSource === item.id)?.source;
          for (const record of Object.values(session.data.results))
            if (record?.source === item.id || (encryptedSource && record?.source === encryptedSource) || record?.key === item.id) {
              if (record.source) session.repairSources.add(record.source);
              if (!record.failed) { record.failed = true; session.markDirty(); }
              ++session.invalidated;
              if (attempt === 1) session.outcome(name === 'maps' ? 'map:' + record.filename : 'image:' + record.source, 'ordinary-failure', item.reason);
            }
          }
        await session.checkpoint();
        if (!rejected.length || shouldCancel()) break;
      }
      const cancelled = shouldCancel() || value?.cancelled;
      session.finishPhase(name, cancelled ? 'cancelled' : value?.error ? 'failed' : 'completed');
      options.onPhaseComplete?.(name, value);
      return value;
    } catch (error) {
      session.finishPhase(name, shouldCancel() ? 'cancelled' : 'failed');
      throw error;
    }
  };
  try {
    if (options.images !== false) {
      if (options.fastBoot !== false) {
        try { result.images = await tryFastImages(options, session) || undefined; }
        catch (error) { logger.warn('[pmjs] fast image boot unavailable: ' + error.message); }
      }
      if (!result.images) result.images = await phase('images', onProgress => prepareAssetsPhase({
        ...options, session, onProgress }));
    }
    if (preparationContext === 'offline')
      for (const entry of result.images?.decryptedEntries || []) native.assets.addDerived?.(entry.logicalSource, entry.file);
    if (!shouldCancel() && options.maps && (session.inventory.some(file => /^data\/Map\d+\.json$/i.test(file)) || session.data.indices.maps))
      result.maps = await phase('maps', onProgress => prepareMapsPhase({ ...options, session, onProgress,
        portableIndex: options.portableIndex?.maps }));
    if (!shouldCancel() && (options.portDescriptors?.length || options.adapters?.length || options.bundleRoot))
      result.portArtifacts = await phase('port', () => prepareForRun({ ...options, session,
        descriptors: options.portDescriptors,
        compressArtifact: native.assets.compressPortArtifact,
        decompressArtifact: native.assets.decompressPortArtifact }));
    result.cancelled = shouldCancel() || result.images?.cancelled || result.maps?.cancelled || false;
    if (!result.cancelled) {
      try { await session.finish(); }
      catch (error) {
        if (preparationContext === 'offline') throw error;
        logger.warn('[pmjs] preparation lease unavailable; using originals: ' + error.message);
        native.assets.installPrepared?.([]);
        native.assets.installDecrypted?.([]);
        native.assets.installImageStorage?.([]);
        native.assets.installTileSets?.([]);
        native.assets.preparedMapIndex = {};
        if (result.images) Object.assign(result.images, { error: error.message, installed: 0, decrypted: 0 });
        if (result.maps) Object.assign(result.maps, { error: error.message, installed: 0, index: {} });
        result.portArtifacts = new Map();
        for (const id of session.outcomes.keys()) session.outcome(id, 'ordinary-failure', error.message);
      }
      // Only a completed, fully verified image phase can produce a catalog: storage and decrypted
      // entries are installed separately each boot and are not represented in it.
      // Failed sources have no result and are recorded in the fingerprint; the full phase would
      // also leave them on ordinary loading. Rejected installs are different: they would make a
      // prepared result silently disappear from the catalog, so those keep the full path.
      if (preparationContext !== 'offline' && !result.images?.fast && !result.images?.error &&
          result.images?.entries?.length && session.phaseStates.get('images') === 'completed' &&
          !result.images.installFailures &&
          !result.images.storageEntries?.length && !result.images.decryptedEntries?.length) {
        await writeCatalog({ root: session.root, results: session.data.results,
          failures: session.data.failures, sources: imageSourceList(session.inventory),
          entries: result.images.entries, processor: imageProcessor(native, options.pageCodec),
          policy: policyIdentity(options) })
          .catch(error => { logger.warn('[pmjs] prepared catalog could not be written: ' + error.message); return false; });
      }
    }
    result.records = session.data.results;
    result.outcomes = [...session.outcomes.values()];
    result.invalidated = session.invalidated;
    result.outcomeCounts = {};
    for (const { outcome } of result.outcomes) result.outcomeCounts[outcome] = (result.outcomeCounts[outcome] || 0) + 1;
    result.validation = session.files.stats;
    result.inventory = { files: session.inventory.length, durationMs: session.inventoryMs };
    result.releaseCacheLease = session.releaseLease;
    const preparationRoot = session.root;
    result.invalidate = source => invalidateResults({ root: preparationRoot, native,
      sources: Array.isArray(source) ? source : [source], logger });
    logger.info?.(`[pmjs] preparation inventory=${result.inventory.files} scan_ms=${result.inventory.durationMs.toFixed(1)} ` +
      `outcomes=${JSON.stringify(result.outcomeCounts)} hashed_files=${result.validation.hashedFiles} hashed_bytes=${result.validation.hashedBytes} reused_files=${result.validation.reusedFiles}`);
    return result;
  } catch (error) {
    logger.warn('[pmjs] preparation unavailable: ' + error.message);
    throw error;
  } finally { await session.close(); }
}

module.exports = { prepareGameAssets };
