'use strict';

const path = require('node:path');
const { openPreparation, inventory, invalidateResults } = require('./preparation-state.cjs');
const { prepareAssets } = require('./asset-preparation.cjs');
const { prepareMaps } = require('./map-preparation.cjs');
const { prepareForRun } = require('./port-preparation.cjs');

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
              record.failed = true; ++session.invalidated;
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
    if (options.images !== false) result.images = await phase('images', onProgress => prepareAssets({
      ...options, session, onProgress }));
    if (preparationContext === 'offline')
      for (const entry of result.images?.decryptedEntries || []) native.assets.addDerived?.(entry.logicalSource, entry.file);
    if (!shouldCancel() && options.maps && (session.inventory.some(file => /^data\/Map\d+\.json$/i.test(file)) || session.data.indices.maps))
      result.maps = await phase('maps', onProgress => prepareMaps({ ...options, session, onProgress,
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
