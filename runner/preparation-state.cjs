'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireLock, createLease, retainLeases } = require('./preparation-lifetime.cjs');
const { preparationFiles, writeJson } = require('./preparation-files.cjs');
const installedLeases = new WeakMap();
const maximumStateBytes = 48 * 1024 * 1024;
const checksumText = value => crypto.createHash('sha256').update(value).digest('hex');
const checksum = value => checksumText(JSON.stringify(value));
const inside = (root, name) => {
  const relative = path.relative(root, path.resolve(name));
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
    throw new Error('preparation path outside cache');
  return relative.split(path.sep).join('/');
};

// Per-game preparation directory. By default it is keyed by the game's absolute path,
// so moving or renaming the game folder starts a new cache. PMJS_PREPARATION_KEY names
// the directory explicitly (e.g. one key per game in a launcher), so the prepared outputs
// survive a moved game folder; source receipts are path-keyed and are simply re-read.
function preparationRoot(cacheRoot, gameRoot) {
  const key = process.env.PMJS_PREPARATION_KEY;
  if (key !== undefined && key !== '') {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) throw new Error('invalid PMJS_PREPARATION_KEY: ' + JSON.stringify(key));
    return path.join(cacheRoot, 'preparation-v1', 'key-' + key);
  }
  return path.join(cacheRoot, 'preparation-v1', checksum(gameRoot).slice(0, 16));
}

// A result's generation: the output format it was prepared for. Results of another
// generation (another runtime version) are kept for a while instead of deleted, so
// switching between runtime versions does not re-prepare the whole cache each time.
// Port results keep the old behaviour (no generation).
function resultGeneration(name, record) {
  if (!record || typeof record !== 'object') return null;
  if (name.startsWith('maps/'))
    return record.compiler !== undefined || record.processor !== undefined ?
      'maps:' + checksum([record.compiler ?? null, record.processor ?? null]).slice(0, 16) : null;
  if (name.startsWith('port/')) return null;
  return record.processor !== undefined ? 'images:' + checksum(record.processor).slice(0, 16) : null;
}
const keptGenerations = () => {
  const value = Number(process.env.PMJS_PREPARATION_KEEP_GENERATIONS ?? 1);
  return Number.isSafeInteger(value) && value >= 0 && value <= 8 ? value : 1;
};
const generationRefreshMs = 24 * 60 * 60 * 1000;

async function readState(filename) {
  if ((await fsp.stat(filename)).size > maximumStateBytes)
    throw new Error('cached preparation state exceeds the memory budget');
  return JSON.parse(await fsp.readFile(filename, 'utf8'));
}

async function writeState(handle, current, serializedData) {
  await handle.writeFile(`{"version":1,"checksum":${JSON.stringify(current)},"data":`);
  const buffer = Buffer.allocUnsafe(256 * 1024);
  for (let offset = 0; offset < serializedData.length;) {
    let end = Math.min(offset + buffer.length / 4, serializedData.length);
    const last = serializedData.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) --end;
    const length = buffer.write(serializedData.slice(offset, end));
    await handle.writeFile(buffer.subarray(0, length));
    offset = end;
  }
  await handle.writeFile('}\n');
}

async function inventory(gameRoot, native, cacheRoot) {
  if (native.fs?.inventory) return native.fs.inventory().filter(source => {
    const physical = native.assets.sourcePath(source);
    return physical && !path.resolve(physical).startsWith(cacheRoot + path.sep);
  }).sort((a,b) => a.localeCompare(b, 'en'));
  const files = [];
  async function visit(logical) {
    if (native.fs?.readDirectory) {
      const names = native.fs.readDirectory(logical || '.') ?? (logical ? [] : await fsp.readdir(gameRoot));
      for (const name of [...names].sort()) {
        const source = logical ? logical + '/' + name : name;
        const resolved = native.fs.resolvePath?.(source) || native.assets.sourcePath?.(source) || path.join(gameRoot, source);
        const directory = native.fs.isDirectory ? native.fs.isDirectory(source) :
          (await fsp.stat(path.join(gameRoot, source)).catch(() => null))?.isDirectory();
        if (directory) {
          if (path.resolve(resolved) !== cacheRoot && !path.resolve(resolved).startsWith(cacheRoot + path.sep)) await visit(source);
        }
        else {
          const physical = native.assets.sourcePath?.(source);
          if (physical && !(path.resolve(physical).startsWith(cacheRoot + path.sep) && native.assets.hasDecrypted?.(source))) files.push(source);
        }
      }
    } else {
      for (const entry of (await fsp.readdir(path.join(gameRoot, logical), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
        const source = logical ? logical + '/' + entry.name : entry.name;
        if (path.resolve(gameRoot, source).startsWith(cacheRoot + path.sep)) continue;
        if (entry.isDirectory()) await visit(source);
        else if (entry.isFile()) files.push(source);
      }
    }
  }
  await visit('');
  return files;
}

async function reclaimLegacyOutputs(cacheRoot, assets, logger) {
  for (const [root, children] of [[cacheRoot, ['entries']], [path.join(cacheRoot, 'maps'), ['entries', 'sources']]]) {
    if (!children.some(name => fs.existsSync(path.join(root, name)))) continue;
    const token = assets.tryAcquirePreparationLock(root);
    if (!token) continue;
    try {
      const retained = new Set();
      await retainLeases(root, retained);
      for (const child of children) {
        const directory = path.join(root, child);
        const names = await fsp.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const name of names) {
          const key = name.replace(/\.png$/, '');
          if (/^[a-f0-9]{64}$/.test(key) && !retained.has(key)) await fsp.rm(path.join(directory, name), { recursive: true, force: true });
        }
      }
    } catch (error) { logger.warn('[pmjs] obsolete preparation output cleanup failed: ' + error.message); }
    finally { assets.releasePreparationLock(token); }
  }
}

async function openPreparation({ gameRoot, cacheRoot, native, verifyHashes = false,
  shouldCancel = () => false, onProgress = () => {}, logger = console, offline = false, sourceRoots = [] }) {
  gameRoot = await fsp.realpath(gameRoot);
  sourceRoots = [gameRoot, ...await Promise.all(sourceRoots.map(root => fsp.realpath(root).catch(() => null)))].filter(Boolean);
  await fsp.mkdir(cacheRoot, { recursive: true });
  cacheRoot = await fsp.realpath(cacheRoot);
  const root = preparationRoot(path.resolve(cacheRoot), gameRoot);
  await fsp.mkdir(root, { recursive: true });
  const releaseLock = await acquireLock(root, shouldCancel,
    () => onProgress({ phase: 'wait', completed: 0, total: 0 }), native.assets);
  if (!releaseLock) return null;
  try {
    await fsp.rm(path.join(root, 'startup-catalog.json'), { force: true });
    await applyPendingInvalidations({ root, native, logger });
    const filename = path.join(root, 'preparation-state.json');
    let saved = {}, verifiedChecksum = null;
    try {
      const record = await readState(filename);
      if (record.version === 1 && record.checksum === checksum(record.data) &&
          record.data && ['files', 'results', 'indices'].every(key => record.data[key] &&
            typeof record.data[key] === 'object' && !Array.isArray(record.data[key]))) {
        saved = record.data;
        // Reuse only when normalization below preserves the exact JSON key order and values.
        if (saved.failures && saved.generations && Object.keys(saved).join(',') === 'files,results,indices,failures,generations')
          verifiedChecksum = record.checksum;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('[pmjs] preparation state unavailable; rebuilding: ' + error.message);
    }
    const data = { files: saved.files || {}, results: saved.results || {}, indices: saved.indices || {}, failures: saved.failures || {},
      generations: saved.generations && typeof saved.generations === 'object' && !Array.isArray(saved.generations) ? saved.generations : {} };
    const pending = new Map(), touched = new Set(), directories = new Map(), currentGenerations = new Set();
    for (const [name, record] of Object.entries(data.results)) {
      if (!record?.key) continue;
      directories.set(path.posix.dirname(name) + '/' + record.key, name);
    }
    let lastChecksum = saved.files ? verifiedChecksum || checksum(data) : null;
    let stateDirty = false;
    let finalizedState = false;
    const session = { root, gameRoot, sourceRoots, data, native, offline, logger, shouldCancel, pending, touched, invalidated: 0,
      phaseStates: new Map(), repairSources: new Set(), outcomes: new Map(),
      markDirty() { stateDirty = true; },
      setIndex(name, value, verifiedUnchanged = false) {
        const previous = data.indices[name];
        const sameList = (left, right) => Array.isArray(left) && Array.isArray(right) &&
          left.length === right.length && left.every((item, index) => item === right[index]);
        if (verifiedUnchanged && name === 'maps' && previous && value && previous.compiler === value.compiler &&
            previous.compilationsHash === value.compilationsHash && previous.mapInputsHash === value.mapInputsHash &&
            sameList(previous.keys, value.keys) && sameList(previous.snapshots, value.snapshots) &&
            sameList(previous.recompileMapInputs, value.recompileMapInputs)) return false;
        if (previous === value) return false;
        data.indices[name] = value;
        stateDirty = true;
        return true;
      },
      outcome(id, outcome, reason) {
        const previous = session.outcomes.get(id)?.outcome;
        if (outcome === 'reused-local' && ['generated', 'reused-package'].includes(previous)) outcome = previous;
        session.outcomes.set(id, { id, outcome, ...(reason ? { reason } : {}) });
        if (outcome === 'ordinary-failure') {
          if (data.failures[id] !== reason) { data.failures[id] = reason; stateDirty = true; }
        } else if (Object.hasOwn(data.failures, id)) { delete data.failures[id]; stateDirty = true; }
      },
      directory(parent, key) {
        return path.join(root, directories.get(parent + '/' + key) || parent + '/' + key);
      },
      newDirectory(parent, key) { return path.join(root, parent, key + "-" + crypto.randomBytes(6).toString("hex")); },
      async checkpoint() {
        if (!stateDirty) return true;
        const serializedData = JSON.stringify(data);
        if (Buffer.byteLength(serializedData) + 128 > maximumStateBytes) {
          if (!session.persistenceWarning) logger.warn('[pmjs] preparation state exceeds the storage budget; keeping the previous checkpoint');
          session.persistenceWarning = true;
          return false;
        }
        const current = checksumText(serializedData);
        if (current === lastChecksum) { stateDirty = false; return true; }
        const temporary = filename + '.stage-' + crypto.randomBytes(6).toString('hex');
        try {
          const handle = await fsp.open(temporary, 'wx');
          try {
            await writeState(handle, current, serializedData);
            await handle.sync();
          }
          finally { await handle.close(); }
          await fsp.rename(temporary, filename);
          lastChecksum = current;
          stateDirty = false;
          return true;
        } catch (error) {
          if (!session.persistenceWarning) logger.warn('[pmjs] preparation state could not be saved: ' + error.message);
          session.persistenceWarning = true;
          return false;
        } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
      },
      readManifest(directory) {
        const relative = inside(root, directory);
        const value = pending.get(relative) || data.results[relative];
        return value?.failed ? null : value;
      },
      touch(directory) { const key = inside(root, directory); if (Object.hasOwn(data.results, key)) touched.add(key); },
      // Each phase registers the generation it prepares, so a phase that touches nothing
      // (every source deleted) still treats its own generation's leftovers as stale.
      useGeneration(name, record) { const generation = resultGeneration(name, record); if (generation) currentGenerations.add(generation); },
      discard(directory) {
        const key = inside(root, directory);
        if (Object.hasOwn(data.results, key)) { ++session.invalidated; stateDirty = true; }
        delete data.results[key]; touched.delete(key);
      },
      startPhase(name) { session.phaseStates.set(name, 'active'); },
      finishPhase(name, state) { session.phaseStates.set(name, state); },
      writeManifest(directory, manifest) {
        pending.set(inside(root, directory), manifest);
      },
      publishManifest(from, to) {
        const relative = inside(root, to), value = pending.get(inside(root, from));
        if (!value) throw new Error('missing staged preparation result');
        const sourceDirectory = path.resolve(from), destinationDirectory = path.resolve(to);
        const outputs = Array.isArray(value.outputs) ? value.outputs.map(output => output?.path) :
          value.outputs && typeof value.outputs === 'object' ? Object.keys(value.outputs) : [];
        for (const output of outputs) {
          if (typeof output !== 'string' || !output || path.isAbsolute(output)) continue;
          const file = path.resolve(sourceDirectory, output);
          if (!file.startsWith(sourceDirectory + path.sep)) continue;
          const receipt = session.files.receipts[file];
          if (!receipt) continue;
          const destination = path.resolve(destinationDirectory, file.slice(sourceDirectory.length + 1));
          session.files.receipts[destination] = receipt;
          data.files[destination] = receipt;
          delete session.files.receipts[file]; delete data.files[file];
          stateDirty = true;
        }
        data.results[relative] = value;
        stateDirty = true;
        directories.set(path.posix.dirname(relative) + '/' + value.key, relative);
        pending.delete(inside(root, from));
        touched.add(relative);
      },
      async finish() {
        const phaseOf = key => key.startsWith('maps/') ? 'maps' : key.startsWith('port/') ? 'port' : 'images';
        const now = Date.now(), current = new Set(currentGenerations);
        for (const generation of current)
          if (!(now - (data.generations[generation] || 0) < generationRefreshMs)) { data.generations[generation] = now; stateDirty = true; }
        for (const key of touched) {
          const generation = resultGeneration(key, data.results[key]);
          if (!generation) continue;
          current.add(generation);
          if (!(now - (data.generations[generation] || 0) < generationRefreshMs)) { data.generations[generation] = now; stateDirty = true; }
        }
        // Untouched results of a current generation are stale (source changed or removed).
        // Untouched results of another generation belong to another runtime version: keep
        // the most recently used `keptGenerations()` other generations per phase.
        const foreign = new Map();
        for (const [key, record] of Object.entries(data.results)) {
          const generation = touched.has(key) ? null : resultGeneration(key, record);
          if (!generation || current.has(generation)) continue;
          const phase = phaseOf(key);
          if (!foreign.has(phase)) foreign.set(phase, new Set());
          foreign.get(phase).add(generation);
        }
        const keep = new Set();
        for (const generations of foreign.values())
          [...generations].sort((a, b) => (data.generations[b] || 0) - (data.generations[a] || 0))
            .slice(0, keptGenerations()).forEach(generation => keep.add(generation));
        const keptDirectories = [];
        for (const key of Object.keys(data.results)) {
          const phase = phaseOf(key);
          if (session.phaseStates.get(phase) === 'completed' && !touched.has(key)) {
            if (keep.has(resultGeneration(key, data.results[key]))) {
              keptDirectories.push(path.join(root, ...key.split('/')) + path.sep);
              continue;
            }
            delete data.results[key]; ++session.invalidated; stateDirty = true;
          }
        }
        const referenced = new Set(Object.entries(data.results).map(([key, record]) => resultGeneration(key, record)));
        for (const generation of Object.keys(data.generations))
          if (!referenced.has(generation)) { delete data.generations[generation]; stateDirty = true; }
        for (const id of Object.keys(data.failures)) {
          const phase = id.startsWith('map:') ? 'maps' : id.startsWith('port:') ? 'port' : 'images';
          if (session.phaseStates.get(phase) === 'completed' && !session.outcomes.has(id)) {
            delete data.failures[id]; stateDirty = true;
          }
        }
        const retained = new Set(Object.keys(data.results).map(value => value.split('/').at(-1)));
        for (const record of Object.values(data.results))
          for (const input of record?.descriptor?.sources || [])
            if (input.snapshot) retained.add(path.basename(input.snapshot, '.png'));
        for (const key of [...(data.indices.maps?.snapshots || []), ...(data.indices.maps?.keys || [])]) retained.add(key);
        for (const [file, receipt] of Object.entries(session.files.receipts)) {
          if (data.files[file] !== receipt) { data.files[file] = receipt; stateDirty = true; }
        }
        // Partial sessions do not visit every phase's files. Prune receipts only
        // after both image and map preparation complete.
        if (session.phaseStates.get('images') === 'completed' && session.phaseStates.get('maps') === 'completed')
          for (const file of Object.keys(data.files)) if (!session.files.receipts[file]) {
            // Output receipts of kept results stay, so switching back does not re-hash them.
            if (keptDirectories.some(directory => file.startsWith(directory))) continue;
            delete data.files[file]; stateDirty = true;
          }
        const committed = await session.checkpoint();
        if (!offline) {
          const previousLease = installedLeases.get(native.assets);
          session.releaseLease = await createLease(root, [...retained]);
          installedLeases.set(native.assets, session.releaseLease);
          previousLease?.();
        }
        if (!committed) return;
        try {
          await retainLeases(root, retained);
          async function prune(directory, nested = false) {
            for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(error => {
              if (error.code === 'ENOENT') return []; throw error;
            })) {
              const file = path.join(directory, entry.name);
              if (nested && entry.isDirectory()) { await prune(file); continue; }
              const key = entry.name.replace(/\.png$/, '');
              if ((/^[a-f0-9]{64}(?:-[a-f0-9]{12})?$/.test(key) || entry.name.startsWith('.stage-')) && !retained.has(key))
                await fsp.rm(file, { recursive: true, force: true });
            }
          }
          for (const name of ['entries', 'maps/entries', 'maps/sources']) await prune(path.join(root, name));
          await prune(path.join(root, 'port'), true);
          await reclaimLegacyOutputs(cacheRoot, native.assets, logger);
        } catch (error) { logger.warn('[pmjs] preparation cleanup deferred: ' + error.message); }
        finalizedState = true;
      },
      async close() {
        try { if (!finalizedState) await session.checkpoint(); }
        finally { releaseLock(); }
      }
    };
    session.files = await preparationFiles(session, verifyHashes);
    const started = performance.now();
    session.inventory = await inventory(path.resolve(gameRoot), native, path.dirname(root));
    session.inventoryMs = performance.now() - started;
    session.retain = async keys => retainLeases(root, keys);
    return session;
  } catch (error) { releaseLock(); throw error; }
}

async function invalidateResults({ root, native, sources, logger = console }) {
  const release = await acquireLock(root, () => false, () => {}, native.assets);
  try {
    const directory = path.join(root, 'invalidations');
    await fsp.mkdir(directory, { recursive: true });
    for (const request of sources) {
      const file = path.join(directory, checksum(request) + '.json');
      if (fs.existsSync(file)) continue;
      const temporary = file + '.stage-' + crypto.randomBytes(6).toString('hex');
      try {
        await writeJson(temporary, { version: 1, request });
        await fsp.rename(temporary, file);
      } finally { await fsp.rm(temporary, { force: true }); }
    }
    logger.info?.('[pmjs] preparation invalidation queued count=' + sources.length + ' deferred=true');
  } catch (error) { logger.warn('[pmjs] cannot record preparation failure: ' + error.message); }
  finally { release(); }
}

async function invalidateCatalog({ root, native }) {
  const release = await acquireLock(root, () => false, () => {}, native.assets);
  try { await fsp.rm(path.join(root, 'startup-catalog.json'), { force: true }); }
  finally { release(); }
}

// The caller holds the preparation lock; full state work stays before guest execution.
async function applyPendingInvalidations({ root, native, logger = console }) {
  try {
    const directory = path.join(root, 'invalidations');
    const names = await fsp.readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    const markers = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => path.join(directory, name));
    if (!markers.length) return;
    const sources = [];
    for (const file of markers) {
      const marker = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (marker.version !== 1 || !(typeof marker.request === 'string' ||
          marker.request && typeof marker.request.source === 'string'))
        throw new Error('invalid preparation invalidation marker');
      sources.push(marker.request);
    }
    const filename = path.join(root, 'preparation-state.json');
    const saved = await readState(filename);
    if (saved.version !== 1 || saved.checksum !== checksum(saved.data)) return;
    const requestsBySource = new Map();
    for (const value of sources) {
      const request = value && typeof value === 'object' ? value : { source: value, mapDemand: false };
      const previous = requestsBySource.get(request.source);
      requestsBySource.set(request.source, { source: request.source,
        mapDemand: !!request.mapDemand || !!previous?.mapDemand });
    }
    const requests = [...requestsBySource.values()];
    let changed = false;
    for (const [key, record] of Object.entries(saved.data.results)) {
      if (!record || typeof record !== 'object') continue;
      const request = requests.find(({ source }) => record.source === source || record.filename === source || record.key === source || record.id === source ||
        record.source && native.assets.sourcePath?.(record.source) === source ||
        record.decrypted && path.join(root, key, record.decrypted) === source);
      if (request) {
        if (!record.failed) { record.failed = true; changed = true; }
        if (request.mapDemand && record.filename && saved.data.indices.maps) {
          const mapInputs = saved.data.indices.maps.mapInputs || {};
          const mapInput = mapInputs[record.filename];
          if (mapInput?.compilationKey && saved.data.indices.maps.compilations)
            delete saved.data.indices.maps.compilations[mapInput.compilationKey];
          delete mapInputs[record.filename];
          const recompile = new Set(saved.data.indices.maps.recompileMapInputs || []);
          recompile.add(record.filename);
          saved.data.indices.maps.recompileMapInputs = [...recompile];
          saved.data.indices.maps.mapInputsHash = checksum(mapInputs);
          if (saved.data.indices.maps.compilations)
            saved.data.indices.maps.compilationsHash = checksum(saved.data.indices.maps.compilations);
          changed = true;
        }
      }
    }
    if (!changed) {
      for (const file of markers) await fsp.rm(file, { force: true });
      return;
    }
    const temporary = filename + '.stage-' + crypto.randomBytes(6).toString('hex');
    try {
      const handle = await fsp.open(temporary, 'wx');
      try {
        const serializedData = JSON.stringify(saved.data);
        await writeState(handle, checksumText(serializedData), serializedData);
        await handle.sync();
      }
      finally { await handle.close(); }
      await fsp.rename(temporary, filename);
    } finally { await fsp.rm(temporary, { force: true }); }
    for (const file of markers) await fsp.rm(file, { force: true });
  } catch (error) { logger.warn('[pmjs] cannot apply preparation invalidations: ' + error.message); }
}

module.exports = { openPreparation, inventory, invalidateResults, invalidateCatalog, preparationRoot, resultGeneration };
