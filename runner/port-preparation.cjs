'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROCESSOR_FILES = 32;
const MAX_DISCOVERED_FILES = 100000;
const MAX_OUTPUTS = 4096;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const PROCESSOR_SUFFIX = '.pmjs-processor.cjs';
const DECLINED = 'declined';
const CACHE_DIRECTORY = 'port-preparation';
const CACHE_MAX_ENTRIES = 128;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function relative(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('\\') &&
    !name.includes('\0') && !path.posix.isAbsolute(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..');
}
function fileInside(root, name) {
  if (!relative(name)) throw new Error('invalid port source path: ' + name);
  const actual = fs.realpathSync(path.join(root, ...name.split('/')));
  const base = fs.realpathSync(root);
  if (!actual.startsWith(base + path.sep) || !fs.statSync(actual).isFile())
    throw new Error('port source outside game: ' + name);
  return actual;
}
function loadProcessor(filename) {
  if (!filename.endsWith('.cjs')) throw new Error('port processor must be a .cjs file');
  const processor = require(filename);
  if (!processor || !ID.test(processor.id) || !Number.isSafeInteger(processor.version) ||
      processor.version < 1 || !(Array.isArray(processor.outputs) &&
      processor.outputs.length > 0 && processor.outputs.length <= MAX_OUTPUTS ||
      typeof processor.discover === 'function' && typeof processor.generate === 'function')) {
    throw new Error('invalid port processor manifest: ' + filename);
  }
  // `files` declares the self-contained sibling modules the entry file requires;
  // they are copied beside it so packaged processors resolve their own imports.
  const files = processor.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_PROCESSOR_FILES) {
    throw new Error('invalid port processor file list: ' + filename);
  }
  const declared = new Set();
  for (const file of files) {
    if (typeof file !== 'string' || !relative(file) || file.endsWith(PROCESSOR_SUFFIX) ||
        declared.has(file) || !file.endsWith('.cjs')) {
      throw new Error('invalid port processor file: ' + filename);
    }
    declared.add(file);
  }
  const ids = new Set();
  for (const entry of processor.outputs || []) {
    if (!entry || !ID.test(entry.id) || !relative(entry.source) ||
        typeof entry.generate !== 'function' || ids.has(entry.id)) {
      throw new Error('invalid/duplicate port output: ' + filename);
    }
    ids.add(entry.id);
  }
  return processor;
}
function scanProcessorFiles(roots) {
  const found = new Set(), visited = new Set();
  function visit(directory) {
    let real;
    try { real = fs.realpathSync(directory); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      const filename = path.join(real, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile() && entry.name.endsWith(PROCESSOR_SUFFIX)) found.add(filename);
    }
  }
  for (const root of roots || []) {
    try {
      const stat = fs.statSync(root);
      visit(stat.isDirectory() ? root : path.dirname(root));
    } catch (_) {}
  }
  return [...found].sort();
}
function discoverAdapterProcessors(adapterFiles) {
  return scanProcessorFiles(adapterFiles);
}
function discoverBundledProcessors(bundleRoot) {
  return bundleRoot ? scanProcessorFiles([path.join(bundleRoot, 'preparation')]) : [];
}
// Discovery is build-time only. Source paths in the resulting bundle are explicit,
// so a recipient does not need to rescan the game or execute discovery at boot.
function scanGameFiles(root) {
  const files = [];
  function visit(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const logical = prefix + entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), logical + '/');
      else if (entry.isFile()) files.push(logical);
      // Do not traverse symlinks, sockets, or special files.
      if (files.length > MAX_DISCOVERED_FILES) throw new Error('too many game files for port discovery');
    }
  }
  visit(fs.realpathSync(root), '');
  return files.sort();
}
function selectedOutputs(processor, gameRoot) {
  if (typeof processor.discover !== 'function') return processor.outputs;
  const files = scanGameFiles(gameRoot);
  const fileSet = new Set(files);
  const read = name => {
    if (!fileSet.has(name)) throw new Error('undeclared discovery source: ' + name);
    const filename = fileInside(gameRoot, name);
    if (fs.statSync(filename).size > MAX_INPUT_BYTES) throw new Error('oversized port input');
    return fs.readFileSync(filename);
  };
  const selected = processor.discover({ files, read });
  if (!Array.isArray(selected) || selected.length > MAX_OUTPUTS)
    throw new Error('port discovery must return 0-' + MAX_OUTPUTS + ' outputs');
  const found = new Set();
  return selected.map(item => {
    if (typeof item === 'string') item = { source: item };
    if (!item || typeof item.source !== 'string' || !fileSet.has(item.source))
      throw new Error('port discovery selected missing/invalid source');
    // Natural default: filename minus extension. Collisions require explicit IDs.
    const defaultId = path.posix.basename(item.source).replace(/\.[^.]+$/, '').toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-');
    const id = item.id || defaultId;
    if (!ID.test(id) || found.has(id)) throw new Error('invalid/duplicate discovered output: ' + id);
    found.add(id);
    return { id, source: item.source,
      generate: bytes => processor.generate(bytes, { id, source: item.source }) };
  });
}
function outputsFor(processor, gameRoot, entries, include, compressArtifact) {
  const outputs = [];
  for (const entry of entries) {
    const source = fileInside(gameRoot, entry.source);
    if (fs.statSync(source).size > MAX_INPUT_BYTES) throw new Error('oversized port input');
    const bytes = fs.readFileSync(source);
    const record = { id: entry.id, source: entry.source, sourceSha256: hash(bytes) };
    if (include) {
      try {
        const produced = entry.generate(bytes);
        if (produced !== null && produced !== undefined) {
          if (!Buffer.isBuffer(produced) && !(produced instanceof Uint8Array))
            throw new Error('port processor output must be binary');
          if (produced.length > MAX_OUTPUT_BYTES) throw new Error('oversized port output');
          const data = Buffer.from(produced);
          const encoded = compressArtifact ? Buffer.from(compressArtifact(data)) : data;
          record.sha256 = hash(encoded);
          record.file = `assets/ports/${processor.id}/${entry.id}.pma1`;
          record.data = encoded;
        }
      } catch (error) {
        console.warn(`[pmjs] port preparation ${processor.id}/${entry.id} skipped during bundling: ${error.message}`);
      }
    }
    outputs.push(record);
  }
  return outputs;
}
function buildPortPreparation({ gameRoot, bundleRoot, processors = [], adapters = [], include = false,
  compressArtifact }) {
  processors = [...new Set([...processors, ...discoverAdapterProcessors(adapters)])];
  const descriptors = [];
  const used = new Set();
  for (const filename of processors) {
    const absolute = fs.realpathSync(filename);
    const processor = loadProcessor(absolute);
    // A package may be built without the user's game files. Keep the processor
    // in the bundle; the device will discover eligible inputs on first launch.
    let selected = [];
    try { selected = selectedOutputs(processor, gameRoot); }
    catch (error) {
      console.warn(`[pmjs] port preparation ${processor.id} discovery skipped during bundling: ${error.message}`);
    }
    selected = selected.filter(entry => {
      try { fileInside(gameRoot, entry.source); return true; }
      catch (error) {
        console.warn(`[pmjs] port preparation ${processor.id}/${entry.id} source skipped: ${error.message}`);
        return false;
      }
    });
    if (used.has(processor.id)) throw new Error('duplicate port processor ID: ' + processor.id);
    used.add(processor.id);
    const directory = `preparation/${processor.id}`;
    const entryFile = `${directory}/${processor.id}${PROCESSOR_SUFFIX}`;
    const destination = path.join(bundleRoot, entryFile);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(absolute, destination, fs.constants.COPYFILE_EXCL);
    const packagedFiles = [];
    for (const file of processor.files ?? []) {
      const record = { path: `${directory}/${file}` };
      const source = fileInside(path.dirname(absolute), file);
      if (!fs.statSync(source).isFile()) throw new Error('missing port processor file: ' + file);
      const target = path.join(bundleRoot, record.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      record.sha256 = hash(fs.readFileSync(target));
      packagedFiles.push(record);
    }
    const records = outputsFor(processor, gameRoot, selected, include, compressArtifact);
    for (const record of records) {
      if (record.data) {
        const output = path.join(bundleRoot, record.file);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, record.data, { flag: 'wx' });
      }
      delete record.data;
    }
    descriptors.push({ id: processor.id, version: processor.version,
      processor: entryFile, processorSha256: hash(fs.readFileSync(destination)),
      ...(packagedFiles.length ? { files: packagedFiles } : {}),
      outputs: records });
  }
  return descriptors;
}
function verifyPortDescriptor(bundleRoot, records, verifyOutputs = true) {
  if (records === undefined) return [];
  if (!Array.isArray(records) || records.length > 32) throw new Error('invalid port preparation descriptors');
  const names = new Set(), ids = new Set();
  for (const desc of records) {
    if (!desc || !ID.test(desc.id) || ids.has(desc.id) ||
        (desc.version !== undefined && (!Number.isSafeInteger(desc.version) || desc.version < 1)) ||
        desc.processor !== `preparation/${desc.id}/${desc.id}${PROCESSOR_SUFFIX}` ||
        !HASH.test(desc.processorSha256) ||
        !Array.isArray(desc.outputs) || desc.outputs.length > MAX_OUTPUTS)
      throw new Error('invalid port preparation descriptor');
    ids.add(desc.id);
    const declaredFiles = desc.files ?? [];
    if (!Array.isArray(declaredFiles) || declaredFiles.length > MAX_PROCESSOR_FILES)
      throw new Error('invalid port processor file list');
    const directory = `preparation/${desc.id}`;
    const packaged = new Set([desc.processor]);
    for (const descriptor of declaredFiles) {
      if (!descriptor || typeof descriptor.path !== 'string' ||
          !relative(descriptor.path) || !descriptor.path.endsWith('.cjs') ||
          !descriptor.path.startsWith(directory + '/') || packaged.has(descriptor.path) ||
          !HASH.test(descriptor.sha256))
        throw new Error('invalid port processor file descriptor');
      packaged.add(descriptor.path);
    }
    const processor = fileInside(bundleRoot, desc.processor);
    if (hash(fs.readFileSync(processor)) !== desc.processorSha256)
      throw new Error('port processor hash mismatch');
    for (const descriptor of declaredFiles) {
      const file = fileInside(bundleRoot, descriptor.path);
      if (hash(fs.readFileSync(file)) !== descriptor.sha256)
        throw new Error('port processor file hash mismatch: ' + descriptor.path);
    }
    const outputs = new Set();
    for (const item of desc.outputs) {
      if (!item || !ID.test(item.id) || outputs.has(item.id) || !relative(item.source) ||
          !HASH.test(item.sourceSha256)) throw new Error('invalid port output descriptor');
      outputs.add(item.id);
      const expected = `assets/ports/${desc.id}/${item.id}.pma1`;
      if (item.file !== undefined || item.sha256 !== undefined) {
        if (item.file !== expected || !HASH.test(item.sha256)) throw new Error('invalid port output file');
        if (verifyOutputs) {
          const file = fileInside(bundleRoot, item.file);
          if (fs.statSync(file).size > MAX_OUTPUT_BYTES + 1024 * 1024 ||
              hash(fs.readFileSync(file)) !== item.sha256)
            throw new Error('port output hash mismatch');
        }
        names.add(item.file);
      }
    }
  }
  return names;
}
function readCacheEntry(output, signature, decompressArtifact) {
  if (fs.existsSync(signature)) {
    const marker = fs.readFileSync(signature, 'utf8').trim();
    if (marker === DECLINED) return fs.existsSync(output) ? null : DECLINED;
  }
  if (fs.existsSync(output) && fs.statSync(output).isFile() &&
      fs.statSync(output).size <= MAX_OUTPUT_BYTES + 1024 * 1024 && fs.existsSync(signature) &&
      fs.readFileSync(signature, 'utf8') === hash(fs.readFileSync(output))) {
    try {
      const bytes = fs.readFileSync(output);
      const decoded = decompressArtifact ? decompressArtifact(bytes) : bytes;
      if (decoded && decoded.length <= MAX_OUTPUT_BYTES) return 'data';
    } catch (_) {}
  }
  return null;
}
function pruneCache(cacheRoot, keep) {
  const root = path.join(cacheRoot, CACHE_DIRECTORY);
  let directories;
  try { directories = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  const now = Date.now();
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const dir = path.join(root, directory.name);
    const entries = new Map();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.pma1') && !name.endsWith('.pma1.sha256')) continue;
      const basename = name.endsWith('.sha256') ? name.slice(0, -7) : name;
      let record = entries.get(basename);
      if (!record) { record = { output: path.join(dir, basename), bytes: 0, mtime: 0 }; entries.set(basename, record); }
      try {
        const stats = fs.lstatSync(path.join(dir, name));
        if (!stats.isFile()) continue;
        record.bytes += stats.size;
        record.mtime = Math.max(record.mtime, stats.mtimeMs);
      } catch (_) {}
    }
    const records = [...entries.values()].sort((a,b) => b.mtime - a.mtime);
    let count = 0, bytes = 0;
    for (const record of records) {
      const retained = keep.has(record.output);
      if (retained) { count++; bytes += record.bytes; continue; }
      if (now - record.mtime <= CACHE_MAX_AGE_MS &&
          count < CACHE_MAX_ENTRIES && bytes + record.bytes <= CACHE_MAX_BYTES) {
        count++; bytes += record.bytes; continue;
      }
      try {
        fs.rmSync(record.output, { force: true });
        fs.rmSync(record.output + '.sha256', { force: true });
      } catch (_) { /* next preparation can retry cleanup */ }
    }
  }
}
function processorIdentity(desc, processor) {
  // Helpers are part of the executable processor, not merely packaging metadata.
  return hash(Buffer.from(JSON.stringify({ main: desc.processorSha256,
    files: (desc.files || []).map(item => [item.path, item.sha256]).sort(),
    version: processor.version })));
}
function processorRecords({ bundleRoot, descriptors, adapters, logger }) {
  if (Array.isArray(descriptors) && descriptors.length) {
    try {
      verifyPortDescriptor(bundleRoot, descriptors, false);
      for (const desc of descriptors) {
        const processor = loadProcessor(fileInside(bundleRoot, desc.processor));
        if (processor.id !== desc.id ||
            desc.version !== undefined && processor.version !== desc.version)
          throw new Error('port processor manifest changed');
      }
      return descriptors;
    }
    catch (error) { logger.warn(`[pmjs] preparation manifest invalid; scanning adapters: ${error.message}`); }
  }
  const filenames = [...discoverBundledProcessors(bundleRoot), ...discoverAdapterProcessors(adapters)];
  const records = [];
  for (const filename of [...new Set(filenames)]) {
    try {
      const processor = loadProcessor(filename);
      const files = (processor.files || []).map(name => {
        const file = fileInside(path.dirname(filename), name);
        return { path: name, sha256: hash(fs.readFileSync(file)) };
      });
      const base = bundleRoot && filename.startsWith(path.resolve(bundleRoot) + path.sep)
        ? path.resolve(bundleRoot) : null;
      const relativeName = base ? path.relative(base, filename).split(path.sep).join('/') : null;
      records.push({ id: processor.id, version: processor.version,
        processor: relativeName || filename,
        processorSha256: hash(fs.readFileSync(filename)),
        ...(files.length ? { files } : {}), outputs: [],
        sourceFile: filename });
    } catch (error) {
      // A malformed optional processor cannot prevent ordinary game startup.
      console.warn(`[pmjs] ignoring invalid port processor ${filename}: ${error.message}`);
    }
  }
  return records;
}
function prepareForRun({ gameRoot, bundleRoot, cacheRoot, descriptors, adapters = [],
  compressArtifact, decompressArtifact, logger = console }) {
  const resolved = new Map();
  if (descriptors !== undefined && (!Array.isArray(descriptors) || descriptors.length > 32)) {
    logger.warn('[pmjs] invalid optional port preparation manifest; original game path retained');
    descriptors = undefined;
  }
  const used = new Set();
  const records = processorRecords({ bundleRoot, descriptors, adapters, logger });
  for (const desc of records) {
    // Runtime validates optional components independently; packaging stays strict.
    try {
      if (!desc.sourceFile) verifyPortDescriptor(bundleRoot, [desc], false);
      const processorFile = desc.sourceFile || fileInside(bundleRoot, desc.processor);
      let processor = loadProcessor(processorFile);
      if (processor.id !== desc.id || desc.version !== undefined && processor.version !== desc.version)
        throw new Error('port processor manifest changed');
      if (Array.isArray(processor.outputs) && processor.outputs.length && desc.outputs?.length) {
        const expected = processor.outputs.map(item => [item.id, item.source]).sort();
        const actual = desc.outputs.map(item => [item.id, item.source]).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual))
          throw new Error('port processor manifest changed');
      }
      let outputs = desc.outputs || [];
      // A manifest is only a fast path. Changed or removed inputs invalidate
      // its inventory, so rerun discovery against the installed game tree.
      if (outputs.length && outputs.some(record => {
        try { return hash(fs.readFileSync(fileInside(gameRoot, record.source))) !== record.sourceSha256; }
        catch { return true; }
      }) && typeof processor.discover === 'function') {
        outputs = selectedOutputs(processor, gameRoot).map(entry => ({
          id: entry.id, source: entry.source,
          sourceSha256: hash(fs.readFileSync(fileInside(gameRoot, entry.source)))
        }));
      }
      if (!outputs.length) {
        outputs = selectedOutputs(processor, gameRoot).map(entry => ({
          id: entry.id, source: entry.source,
          sourceSha256: hash(fs.readFileSync(fileInside(gameRoot, entry.source)))
        }));
      }
      for (const record of outputs) {
        try {
          const input = fs.readFileSync(fileInside(gameRoot, record.source));
          if (input.length > MAX_INPUT_BYTES) throw new Error('oversized port input');
          const inputHash = hash(input);
          if (record.file && inputHash === record.sourceSha256) {
            try {
              const bytes = fs.readFileSync(fileInside(bundleRoot, record.file));
              if (hash(bytes) === record.sha256 &&
                  (!decompressArtifact || decompressArtifact(bytes))) {
                resolved.set(`${desc.id}/${record.id}`, fileInside(bundleRoot, record.file));
                used.add(fileInside(bundleRoot, record.file));
                continue;
              }
              throw new Error('packaged hash differs from pmjs.json');
            } catch (packagingFailure) {
              logger.warn(`[pmjs] port preparation ${desc.id}/${record.id}: ` +
                `packaged data unusable, regenerating locally (${packagingFailure.message})`);
            }
          }
          const key = hash(Buffer.from([processorIdentity(desc, processor), record.id, inputHash].join(':')));
          const output = path.join(cacheRoot, CACHE_DIRECTORY, desc.id, `${key}.pma1`);
          const signature = `${output}.sha256`;
          const entryState = readCacheEntry(output, signature, decompressArtifact);
          if (entryState === 'data') {
            resolved.set(`${desc.id}/${record.id}`, output);
            used.add(output);
            continue;
          }
          if (entryState === DECLINED) continue; // known-declined source content
          const entry = processor.outputs?.find(v => v.id === record.id);
          const value = entry ? entry.generate(input) : processor.generate(input,
            { id: record.id, source: record.source });
          if (value === null || value === undefined) {
            fs.mkdirSync(path.dirname(signature), { recursive: true });
            fs.writeFileSync(signature, DECLINED);
            continue;
          }
          if ((!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) ||
              !value.length || value.length > MAX_OUTPUT_BYTES)
            throw new Error('invalid prepared port data');
          fs.mkdirSync(path.dirname(output), { recursive: true });
          const temp = `${output}.${process.pid}.tmp`;
          try {
            const encoded = compressArtifact ? Buffer.from(compressArtifact(Buffer.from(value))) : Buffer.from(value);
            if (!encoded.length || encoded.length > MAX_OUTPUT_BYTES + 1024 * 1024)
              throw new Error('invalid compressed port data');
            fs.writeFileSync(temp, encoded);
            fs.renameSync(temp, output);
            fs.writeFileSync(signature, hash(encoded));
          } finally { fs.rmSync(temp, { force: true }); }
          resolved.set(`${desc.id}/${record.id}`, output);
          used.add(output);
        } catch (error) {
          logger.warn(`[pmjs] port preparation ${desc.id}/${record.id} unavailable: ${error.message}`);
          // Missing or unsuitable derivations must leave the game's normal path working.
        }
      }
    } catch (descriptorFailure) {
      logger.warn(`[pmjs] port preparation ${desc?.id || '<invalid>'} unavailable: ${descriptorFailure.message}`);
    }
  }
  try { pruneCache(cacheRoot, used); }
  catch (error) { logger.warn('[pmjs] port cache cleanup skipped: ' + error.message); }
  return resolved;
}
function reader(files, decompressArtifact) {
  return name => {
    const file = typeof name === 'string' &&
      (files instanceof Map ? files.get(name) :
       Object.prototype.hasOwnProperty.call(files, name) ? files[name] : null);
    if (!file) return null;
    try {
      if (fs.statSync(file).size > MAX_OUTPUT_BYTES + 1024 * 1024) return null;
      const bytes = fs.readFileSync(file);
      return decompressArtifact ? decompressArtifact(bytes) : bytes;
    }
    catch { return null; }
  };
}
module.exports = { buildPortPreparation, verifyPortDescriptor, prepareForRun, reader,
  loadProcessor, relative, discoverAdapterProcessors, discoverBundledProcessors };
