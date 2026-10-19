'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const HASH = /^[a-f0-9]{64}$/;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function writeJson(file, value, flush = true) {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    if (flush) await handle.sync();
  } finally { await handle.close(); }
}

async function preparationFiles(directory, verifyHashes = false) {
  const index = path.join(directory, 'verified-files.json');
  let previous = {}, previousHash;
  try {
    const saved = JSON.parse(await fsp.readFile(index, 'utf8'));
    if (saved.version === 1 && saved.files && saved.hash === digest(JSON.stringify(saved.files))) {
      previous = saved.files; previousHash = saved.hash;
    }
  } catch (_) { /* Missing or interrupted receipts require full verification. */ }
  const files = {}, known = new Map(), jsonValues = new Map();
  const stats = { hashedFiles: 0, hashedBytes: 0, reusedFiles: 0, jsonReads: 0, jsonReuses: 0,
    copiedFiles: 0, copiedBytes: 0, publicationReuses: 0, hashedBytesByCategory: {} };
  function identity(stat) {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
  }
  async function inspect(file, category = 'other') {
    file = path.resolve(file);
    const before = await fsp.lstat(file, { bigint: true });
    if (!before.isFile()) throw new Error('preparation input is not a regular file');
    const signature = identity(before);
    const cached = previous[file];
    const retained = known.get(signature);
    let header = retained?.header;
    let checksum = !verifyHashes && (retained?.hash ||
      cached && cached.identity === signature && HASH.test(cached.hash) && cached.hash);
    const reused = !!checksum;
    if (reused) ++stats.reusedFiles;
    else {
      const hasher = crypto.createHash('sha256');
      header = Buffer.alloc(0);
      for await (const chunk of fs.createReadStream(file)) {
        hasher.update(chunk);
        if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
      }
      checksum = hasher.digest('hex');
      ++stats.hashedFiles; stats.hashedBytes += Number(before.size);
      stats.hashedBytesByCategory[category] = (stats.hashedBytesByCategory[category] || 0) + Number(before.size);
      const after = await fsp.lstat(file, { bigint: true });
      if (!after.isFile() || identity(after) !== signature) throw new Error('preparation input changed while verifying');
    }
    files[file] = { identity: signature, hash: checksum };
    known.set(signature, { hash: checksum, header });
    return { hash: checksum, reused, size: Number(before.size), header };
  }
  async function hash(file, category) { return (await inspect(file, category)).hash; }
  async function copyVerified(source, target, expectedHash, category = 'import') {
    if (!HASH.test(expectedHash)) throw new Error('invalid expected copy checksum');
    const input = await fsp.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let output, created = false;
    try {
      const before = await input.stat({ bigint: true });
      if (!before.isFile()) throw new Error('copy input is not a regular file');
      output = await fsp.open(target, 'wx'); created = true;
      const hasher = crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
      let header = Buffer.alloc(0), size = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        hasher.update(chunk); size += bytesRead;
        if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
        await output.writeFile(chunk);
      }
      ++stats.hashedFiles; stats.hashedBytes += size;
      stats.hashedBytesByCategory[category] = (stats.hashedBytesByCategory[category] || 0) + size;
      const checksum = hasher.digest('hex');
      if (checksum !== expectedHash) throw new Error('copied input checksum differs');
      if (identity(before) !== identity(await input.stat({ bigint: true })) ||
          identity(before) !== identity(await fsp.lstat(source, { bigint: true })))
        throw new Error('copy input changed while copying');
      const written = await output.stat({ bigint: true });
      if (!written.isFile() || Number(written.size) !== size ||
          identity(written) !== identity(await fsp.lstat(target, { bigint: true })))
        throw new Error('copy output changed while copying');
      const signature = identity(written);
      files[path.resolve(target)] = { identity: signature, hash: checksum };
      known.set(signature, { hash: checksum, header });
      ++stats.copiedFiles; stats.copiedBytes += size;
      return { hash: checksum, header, size };
    } catch (error) {
      if (created) await fsp.rm(target, { force: true });
      throw error;
    } finally { try { await output?.close(); } finally { await input.close(); } }
  }
  async function publish(source, target) {
    const from = path.resolve(source), to = path.resolve(target), receipt = files[from];
    const before = receipt && await fsp.lstat(from, { bigint: true }).catch(() => null);
    await fsp.rename(source, target);
    // Directory renames preserve child identities, so inspect can reuse them directly.
    if (!before?.isFile() || identity(before) !== receipt.identity) return;
    const after = await fsp.lstat(to, { bigint: true });
    // A directly renamed file may acquire a new ctime; retain the other identity fields.
    if (!after.isFile() || ['dev', 'ino', 'size', 'mtimeNs', 'birthtimeNs'].some(key => before[key] !== after[key])) return;
    const signature = identity(after);
    files[to] = { ...receipt, identity: signature };
    known.set(signature, known.get(receipt.identity) || { hash: receipt.hash });
    ++stats.publicationReuses;
  }
  async function validatedJson(file, validate) {
    file = path.resolve(file);
    const before = await fsp.lstat(file, { bigint: true });
    if (!before.isFile()) return null;
    const signature = identity(before), cached = previous[file] || jsonValues.get(signature);
    const reused = !verifyHashes && cached?.identity === signature && cached.json !== undefined;
    let value, checksum;
    if (reused) { value = cached.json; checksum = cached.hash; ++stats.jsonReuses; }
    else {
      const bytes = await fsp.readFile(file);
      value = JSON.parse(bytes); checksum = digest(bytes); ++stats.jsonReads;
    }
    if (!await validate(value, reused)) return null;
    const after = await fsp.lstat(file, { bigint: true });
    if (!after.isFile() || identity(after) !== signature) return null;
    files[file] = { identity: signature, hash: checksum, json: value };
    jsonValues.set(signature, files[file]);
    return value;
  }
  async function save() {
    const checksum = digest(JSON.stringify(files));
    if (checksum === previousHash) return;
    const temporary = index + '.stage-' + crypto.randomBytes(6).toString('hex');
    try {
      await fsp.writeFile(temporary, JSON.stringify({ version: 1, files, hash: checksum }) + '\n', { flag: 'wx' });
      await fsp.rename(temporary, index);
    } finally { await fsp.rm(temporary, { force: true }); }
  }
  return { hash, inspect, copyVerified, publish, validatedJson, save, stats };
}

module.exports = { preparationFiles, writeJson };
