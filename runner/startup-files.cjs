'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');

// Receipts are local metadata-based verification, not a signed installation seal.
function startupFiles(file, generation, verify = false) {
  let previous = {}, savedChecksum;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version === 1 && saved.generation === generation && saved.files &&
        saved.checksum === digest(JSON.stringify(saved.files))) {
      previous = saved.files; savedChecksum = saved.checksum;
    }
  } catch { /* First launch, upgrade or damaged receipt requires content hashing. */ }
  const files = {};
  const stats = { hashedFiles: 0, hashedBytes: 0, reusedFiles: 0 };
  function hash(name) {
    name = path.resolve(name);
    const before = fs.statSync(name, { bigint: true });
    if (!before.isFile()) throw new Error('startup input is not a regular file: ' + name);
    const signature = identity(before), cached = files[name] || previous[name];
    if (!verify && cached?.identity === signature && /^[a-f0-9]{64}$/.test(cached.hash)) {
      files[name] = cached; ++stats.reusedFiles; return cached.hash;
    }
    const descriptor = fs.openSync(name, 'r');
    let checksum;
    try {
      if (identity(fs.fstatSync(descriptor, { bigint: true })) !== signature) throw new Error('startup input replaced before hashing');
      const hasher = crypto.createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
      let count;
      while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
        hasher.update(buffer.subarray(0, count)); stats.hashedBytes += count;
      }
      checksum = hasher.digest('hex'); ++stats.hashedFiles;
      if (identity(fs.fstatSync(descriptor, { bigint: true })) !== signature ||
          identity(fs.statSync(name, { bigint: true })) !== signature) throw new Error('startup input changed while hashing');
    } finally { fs.closeSync(descriptor); }
    files[name] = { identity: signature, hash: checksum };
    return checksum;
  }
  function save() {
    const checksum = digest(JSON.stringify(files));
    if (checksum === savedChecksum) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.stage-' + crypto.randomBytes(6).toString('hex');
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, generation, files,
        checksum }) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
      savedChecksum = checksum;
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return { hash, save, stats };
}

function runtimeIdentity(share, hash) {
  const checksum = crypto.createHash('sha256');
  for (const folder of ['js', 'profiles']) {
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) { checksum.update(path.relative(share, file)); checksum.update(hash(file)); }
      }
    };
    visit(path.join(share, folder));
  }
  for (const name of ['build-js-runtime.mjs', 'build-js-composition.mjs', 'game-inspect.mjs', 'achievement-discovery.mjs']) {
    checksum.update(name); checksum.update(hash(path.join(share, 'tools', name)));
  }
  return checksum.digest('hex');
}

module.exports = { startupFiles, runtimeIdentity };
