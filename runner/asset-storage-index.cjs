'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validStorageDecision } = require('./asset-preparation.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function storageClassifier(assets, cacheRoot) {
  const version = assets.imageStorageVersion;
  const file = path.join(cacheRoot, 'image-storage.json');
  let saved = {};
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record && record.decisions && typeof record.decisions === 'object' && record.version === version &&
        record.checksum === hash(JSON.stringify(record.decisions))) saved = record.decisions;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const pending = new Map(), decisions = {};
  return {
    async classify(source) {
      const checksum = hash(fs.readFileSync(source));
      if (!pending.has(checksum)) {
        const work = (async () => {
          const storage = validStorageDecision(saved[checksum]) ? saved[checksum] :
            await assets.classifyImageStorage(source);
          if (!validStorageDecision(storage)) throw new Error('invalid image storage decision');
          if (hash(fs.readFileSync(source)) !== checksum)
            throw new Error('image changed during storage classification');
          decisions[checksum] = storage;
          return storage;
        })();
        pending.set(checksum, work);
        work.catch(() => pending.delete(checksum));
      }
      const storage = await pending.get(checksum);
      if (hash(fs.readFileSync(source)) !== checksum)
        throw new Error('image changed during storage classification');
      return storage;
    },
    save() {
      const ordered = Object.fromEntries(Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b)));
      const next = file + '.stage-' + process.pid;
      try {
        fs.writeFileSync(next, JSON.stringify({ version,
          checksum: hash(JSON.stringify(ordered)), decisions: ordered }));
        fs.renameSync(next, file);
      } finally { fs.rmSync(next, { force: true }); }
    }
  };
}

async function mapStorageInputs(values, operation, concurrency = 4) {
  const results = new Array(values.length);
  let next = 0, failed = false;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && next < values.length) {
      const index = next++;
      try { results[index] = await operation(values[index]); }
      catch (error) { failed = true; throw error; }
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

module.exports = { storageClassifier, mapStorageInputs };
