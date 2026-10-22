'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const HASH = /^[a-f0-9]{64}$/;
// Files on a device whose identity changed only in its inode number are re-hashed until this many
// of them have kept their recorded hash; see renumberedHash below.
const RENUMBER_SAMPLE = 8;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function writeJson(file, value, flush = true) {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    if (flush) await handle.sync();
  } finally { await handle.close(); }
}

async function preparationFiles(session, verifyHashes = false) {
  const previous = session.data.files;
  const files = {}, known = new Map();
  const stats = { hashedFiles: 0, hashedBytes: 0, reusedFiles: 0, renumberedFiles: 0, jsonReads: 0, jsonReuses: 0,
    copiedFiles: 0, copiedBytes: 0, publicationReuses: 0, hashedBytesByCategory: {} };
  function identity(stat) {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
  }
  // Some filesystems give files new inode numbers in every process (FUSE mounts without stable
  // inodes, such as exFAT SD cards on handheld firmware), so no identity repeats across sessions
  // and every file would be hashed again on every start. When a file's identity differs from its
  // record only in the inode, the first RENUMBER_SAMPLE such files on that device are hashed;
  // once all of them kept their recorded hash, the device is taken to renumber inodes and later
  // such files reuse their record. One changed file keeps the device on full hashing.
  const renumbering = new Map();
  function renumberedHash(cached, signature) {
    if (verifyHashes || !cached || !HASH.test(cached.hash || '') || typeof cached.identity !== 'string') return null;
    const recorded = cached.identity.split(':'), current = signature.split(':');
    if (recorded.length !== 6 || current.length !== 6 || recorded[0] !== current[0] || recorded[1] === current[1] ||
        recorded.slice(2).join(':') !== current.slice(2).join(':')) return null;
    const device = renumbering.get(current[0]) || { verified: 0, changed: false };
    renumbering.set(current[0], device);
    return { device, hash: !device.changed && device.verified >= RENUMBER_SAMPLE ? cached.hash : null };
  }
  function verifiedRenumbering(renumbered, checksum, cached) {
    if (!renumbered) return;
    if (checksum === cached.hash) ++renumbered.device.verified;
    else renumbered.device.changed = true;
  }
  function containedGameFile(file) {
    return (session.sourceRoots || [session.gameRoot]).some(root => {
      if (!root) return false;
      const relative = path.relative(root, file);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
  }
  async function inspectPath(file) {
    const lexical = path.resolve(file);
    const link = await fsp.lstat(lexical, { bigint: true });
    if (!link.isSymbolicLink() || !containedGameFile(lexical)) return { file: lexical, stat: link };
    const resolved = await fsp.realpath(lexical);
    if (!containedGameFile(resolved)) throw new Error('preparation symlink target outside game root');
    const stat = await fsp.stat(resolved, { bigint: true });
    if (!stat.isFile()) throw new Error('preparation input is not a regular file');
    return { file: resolved, stat, gameRooted: true };
  }
  async function inspect(file, category = 'other') {
    file = path.resolve(file);
    const inspected = await inspectPath(file), actual = inspected.file, before = inspected.stat;
    if (!before.isFile()) throw new Error('preparation input is not a regular file');
    const signature = identity(before);
    const cached = previous[file];
    const retained = known.get(signature);
    let header = retained?.header || (cached?.header ? Buffer.from(cached.header, "base64") : undefined);
    let checksum = (retained?.hash || !verifyHashes &&
      cached && cached.identity === signature && HASH.test(cached.hash) && cached.hash);
    const renumbered = !checksum && renumberedHash(cached, signature);
    if (renumbered?.hash) { checksum = renumbered.hash; ++stats.renumberedFiles; }
    const reused = !!checksum;
    if (reused) ++stats.reusedFiles;
    else {
      const hasher = crypto.createHash('sha256');
      header = Buffer.alloc(0);
      for await (const chunk of fs.createReadStream(actual)) {
        hasher.update(chunk);
        if (header.length < 32) header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
      }
      checksum = hasher.digest('hex');
      ++stats.hashedFiles; stats.hashedBytes += Number(before.size);
      stats.hashedBytesByCategory[category] = (stats.hashedBytesByCategory[category] || 0) + Number(before.size);
      const after = await fsp.stat(actual, { bigint: true });
      if (!after.isFile() || identity(after) !== signature ||
          inspected.gameRooted && await fsp.realpath(file) !== actual)
        throw new Error('preparation input changed while verifying');
      verifiedRenumbering(renumbered, checksum, cached);
    }
    // An unchanged file whose inode was renumbered keeps its record, so the saved state (and the
    // state file on disk) stays the same from launch to launch.
    files[file] = renumbered && checksum === cached.hash ? cached :
      { identity: signature, hash: checksum, ...(header ? { header: header.toString("base64") } : {}) };
    session.data.files[file] = files[file];
    known.set(signature, { hash: checksum, header });
    return { hash: checksum, reused, size: Number(before.size), header };
  }
  function inspectSync(file, bytes, category = 'other') {
    file = path.resolve(file);
    const link = fs.lstatSync(file, { bigint: true });
    let stat = link;
    if (link.isSymbolicLink()) {
      if (!containedGameFile(file)) throw new Error('preparation input symlink is not authorized');
      const actual = fs.realpathSync(file);
      if (!containedGameFile(actual)) throw new Error('preparation symlink target outside game root');
      stat = fs.statSync(actual, { bigint: true });
    }
    if (!stat.isFile()) throw new Error('preparation input is not a regular file');
    const signature = identity(stat), retained = known.get(signature), cached = previous[file];
    let checksum = retained?.hash || !verifyHashes && cached?.identity === signature && cached.hash;
    const renumbered = !checksum && renumberedHash(cached, signature);
    if (renumbered?.hash) { checksum = renumbered.hash; ++stats.renumberedFiles; }
    if (!checksum) {
      checksum = digest(bytes);
      ++stats.hashedFiles; stats.hashedBytes += bytes.length;
      stats.hashedBytesByCategory[category] = (stats.hashedBytesByCategory[category] || 0) + bytes.length;
      verifiedRenumbering(renumbered, checksum, cached);
    } else ++stats.reusedFiles;
    const header = Buffer.from(bytes.subarray(0, 32));
    files[file] = renumbered && checksum === cached.hash ? cached :
      { identity: signature, hash: checksum, header: header.toString('base64') };
    session.data.files[file] = files[file];
    known.set(signature, { hash: checksum, header });
    return { hash: checksum, size: bytes.length, header };
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
  async function validatedManifest(directory, validate) {
    const value = session.readManifest(directory);
    if (!value || !await validate(value, !verifyHashes)) return null;
    session.touch(directory);
    return value;
  }
  async function validateOutputs(directory, outputs, checksumOf, validate) {
    for (const output of outputs) {
      const expected = checksumOf(output);
      if (!HASH.test(expected || '')) return false;
      const file = path.join(directory, output.path);
      const checked = await inspect(file, 'output');
      if (checked.hash !== expected || !await validate(output, file, checked)) return false;
    }
    return true;
  }
  async function save() {
    Object.assign(session.data.files, files);
    await session.checkpoint();
  }
  return { hash, inspect, inspectSync, copyVerified, publish, validatedManifest, validateOutputs, save, stats, receipts: files,
    writeManifest: session.writeManifest,
    publishManifest: session.publishManifest };

}

module.exports = { preparationFiles, writeJson };
