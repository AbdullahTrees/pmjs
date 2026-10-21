'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireLock, createLease, retainLeases } = require('./preparation-lifetime.cjs');
const { preparationFiles } = require('./preparation-files.cjs');
const installedLeases = new WeakMap();
const checksum = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (root, name) => {
  const relative = path.relative(root, path.resolve(name));
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
    throw new Error('preparation path outside cache');
  return relative.split(path.sep).join('/');
};

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
  shouldCancel = () => false, onProgress = () => {}, logger = console, offline = false }) {
  gameRoot = await fsp.realpath(gameRoot);
  await fsp.mkdir(cacheRoot, { recursive: true });
  cacheRoot = await fsp.realpath(cacheRoot);
  const root = path.join(path.resolve(cacheRoot), 'preparation-v1', checksum(gameRoot).slice(0, 16));
  await fsp.mkdir(root, { recursive: true });
  const releaseLock = await acquireLock(root, shouldCancel,
    () => onProgress({ phase: 'wait', completed: 0, total: 0 }), native.assets);
  if (!releaseLock) return null;
  try {
    const filename = path.join(root, 'preparation-state.json');
    let saved = {};
    try {
      const record = JSON.parse(await fsp.readFile(filename, 'utf8'));
      if (record.version === 1 && record.checksum === checksum(record.data) &&
          record.data && ['files', 'results', 'indices'].every(key => record.data[key] &&
            typeof record.data[key] === 'object' && !Array.isArray(record.data[key]))) saved = record.data;
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('[pmjs] preparation state unavailable; rebuilding: ' + error.message);
    }
    const data = { files: saved.files || {}, results: saved.results || {}, indices: saved.indices || {}, failures: saved.failures || {} };
    const pending = new Map(), touched = new Set(), directories = new Map();
    for (const [name, record] of Object.entries(data.results)) {
      if (!record?.key) continue;
      directories.set(path.posix.dirname(name) + '/' + record.key, name);
    }
    let lastChecksum = saved.files ? checksum(data) : null;
    const session = { root, data, native, offline, logger, shouldCancel, pending, touched, phases: new Set(), repairSources: new Set(), outcomes: new Map(),
      outcome(id, outcome, reason) {
        const previous = session.outcomes.get(id)?.outcome;
        if (outcome === 'reused-local' && ['generated', 'reused-package'].includes(previous)) outcome = previous;
        session.outcomes.set(id, { id, outcome, ...(reason ? { reason } : {}) });
        if (outcome === 'ordinary-failure') data.failures[id] = reason;
        else delete data.failures[id];
      },
      directory(parent, key) {
        return path.join(root, directories.get(parent + '/' + key) || parent + '/' + key);
      },
      newDirectory(parent, key) { return path.join(root, parent, key + "-" + crypto.randomBytes(6).toString("hex")); },
      async checkpoint() {
        const current = checksum(data);
        if (current === lastChecksum) return true;
        const temporary = filename + '.stage-' + crypto.randomBytes(6).toString('hex');
        try {
          const handle = await fsp.open(temporary, 'wx');
          try { await handle.writeFile(JSON.stringify({ version: 1, checksum: current, data }) + '\n'); await handle.sync(); }
          finally { await handle.close(); }
          await fsp.rename(temporary, filename);
          lastChecksum = current;
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
      writeManifest(directory, manifest) {
        pending.set(inside(root, directory), manifest);
      },
      publishManifest(from, to) {
        const relative = inside(root, to), value = pending.get(inside(root, from));
        if (!value) throw new Error('missing staged preparation result');
        for (const [file, receipt] of Object.entries(session.files.receipts)) {
          if (!file.startsWith(path.resolve(from) + path.sep)) continue;
          const destination = path.resolve(to) + file.slice(path.resolve(from).length);
          session.files.receipts[destination] = receipt;
          data.files[destination] = receipt;
          delete session.files.receipts[file]; delete data.files[file];
        }
        data.results[relative] = value;
        directories.set(path.posix.dirname(relative) + '/' + value.key, relative);
        pending.delete(inside(root, from));
        touched.add(relative);
      },
      async finish() {
        for (const key of Object.keys(data.results)) {
          const phase = key.startsWith('maps/') ? 'maps' : key.startsWith('port/') ? 'port' : 'images';
          if (session.phases.has(phase) && !touched.has(key)) delete data.results[key];
        }
        for (const id of Object.keys(data.failures)) {
          const phase = id.startsWith('map:') ? 'maps' : id.startsWith('port:') ? 'port' : 'images';
          if (session.phases.has(phase) && !session.outcomes.has(id)) delete data.failures[id];
        }
        const retained = new Set(Object.keys(data.results).map(value => value.split('/').at(-1)));
        for (const record of Object.values(data.results))
          for (const input of record?.descriptor?.sources || [])
            if (input.snapshot) retained.add(path.basename(input.snapshot, '.png'));
        for (const key of [...(data.indices.maps?.snapshots || []), ...(data.indices.maps?.keys || [])]) retained.add(key);
        Object.assign(data.files, session.files.receipts);
        for (const file of Object.keys(data.files)) if (!session.files.receipts[file]) delete data.files[file];
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
      },
      async close() {
        try { await session.checkpoint(); }
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
    const filename = path.join(root, 'preparation-state.json');
    const saved = JSON.parse(await fsp.readFile(filename, 'utf8'));
    if (saved.version !== 1 || saved.checksum !== checksum(saved.data)) return;
    let changed = false;
    for (const [key, record] of Object.entries(saved.data.results)) {
      if (!record || typeof record !== 'object' || record.failed) continue;
      if (sources.some(source => record.source === source || record.filename === source || record.key === source ||
          record.source && native.assets.sourcePath?.(record.source) === source ||
          record.decrypted && path.join(root, key, record.decrypted) === source)) {
        record.failed = true; changed = true;
      }
    }
    if (!changed) return;
    const temporary = filename + '.stage-' + crypto.randomBytes(6).toString('hex');
    try {
      const handle = await fsp.open(temporary, 'wx');
      try { await handle.writeFile(JSON.stringify({ ...saved, checksum: checksum(saved.data) }) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await fsp.rename(temporary, filename);
    } finally { await fsp.rm(temporary, { force: true }); }
  } catch (error) { logger.warn('[pmjs] cannot record preparation failure: ' + error.message); }
  finally { release(); }
}

module.exports = { openPreparation, inventory, invalidateResults };
