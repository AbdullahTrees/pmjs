'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { preparationFiles } = require('../runner/preparation-files.cjs');
const copyFiles = () => preparationFiles({ data: { files: {} }, checkpoint: async () => {} });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('synchronous verification retains an owned small header rather than the source buffer', async () => {
  const root = temporaryDirectory('verified-header-'), source = path.join(root, 'source');
  const bytes = Buffer.alloc(4 * 1024 * 1024, 73);
  fs.writeFileSync(source, bytes);
  const files = await copyFiles(), checked = files.inspectSync(source, bytes);
  assert.equal(checked.hash, hash(bytes));
  assert.equal(checked.header.length, 32);
  assert.ok(checked.header.buffer.byteLength < bytes.byteLength, 'a header must not pin the full source allocation');
  bytes.fill(0);
  const reused = await files.inspect(source);
  assert.equal(reused.reused, true);
  assert.deepEqual(reused.header, Buffer.alloc(32, 73), 'caller mutation must not change the verified header');
});

test('verified copies publish without rereading staged or published bytes and invalidate on edits', async () => {
  const root = temporaryDirectory('verified-copy-'), source = path.join(root, 'source');
  const stage = path.join(root, 'stage'), published = path.join(root, 'published');
  fs.mkdirSync(stage);
  const bytes = Buffer.alloc(700 * 1024, 73); fs.writeFileSync(source, bytes);
  const files = await copyFiles(), expected = hash(bytes);
  const checked = await files.copyVerified(source, path.join(stage, 'page'), expected);
  assert.equal(checked.size, bytes.length);
  assert.equal(await files.hash(path.join(stage, 'page')), expected);
  await files.publish(stage, published);
  assert.equal(await files.hash(path.join(published, 'page')), expected);
  assert.equal(files.stats.hashedBytes, bytes.length, 'one streaming pass across copy and publication');
  assert.equal(files.stats.copiedBytes, bytes.length);
  fs.appendFileSync(path.join(published, 'page'), 'damage');
  assert.notEqual(await files.hash(path.join(published, 'page')), expected);
});

test('replacement of a staged object cannot inherit its verification receipt', async () => {
  const root = temporaryDirectory('copy-replacement-'), source = path.join(root, 'source');
  const stage = path.join(root, 'stage'), published = path.join(root, 'published');
  fs.writeFileSync(source, 'original');
  const files = await copyFiles(), expected = hash('original');
  await files.copyVerified(source, stage, expected);
  fs.writeFileSync(stage + '.replacement', 'replaced'); fs.renameSync(stage + '.replacement', stage);
  await files.publish(stage, published);
  assert.notEqual(await files.hash(published), expected);
  assert.equal(files.stats.publicationReuses, 0);
});

test('an in-root symlink replaced with an escaping target during hashing is rejected', async t => {
  const root = temporaryDirectory('symlink-replacement-'), gameRoot = path.join(root, 'game');
  fs.mkdirSync(gameRoot);
  const target = path.join(gameRoot, 'target'), link = path.join(gameRoot, 'image.png');
  const outside = path.join(root, 'outside');
  fs.writeFileSync(target, 'inside'); fs.writeFileSync(outside, 'outside'); fs.symlinkSync(target, link);
  const session = { gameRoot, data: { files: {} }, checkpoint: async () => {} };
  const files = await preparationFiles(session), realpath = fs.promises.realpath;
  let checks = 0;
  t.mock.method(fs.promises, 'realpath', async (...args) => {
    if (path.resolve(String(args[0])) === link && ++checks === 2) {
      fs.unlinkSync(link); fs.symlinkSync(outside, link);
    }
    return realpath(...args);
  });
  await assert.rejects(files.inspect(link), /preparation input changed while verifying/);
  assert.equal(Object.hasOwn(files.receipts, link), false);
});

test('checksum mismatch and failed publication never create a verified published object', async () => {
  const root = temporaryDirectory('copy-failure-'), source = path.join(root, 'source');
  const stage = path.join(root, 'stage'); fs.writeFileSync(source, 'original');
  const files = await copyFiles();
  await assert.rejects(files.copyVerified(source, stage, hash('wrong')), /checksum differs/);
  assert.equal(fs.existsSync(stage), false);
  await files.copyVerified(source, stage, hash('original'));
  await assert.rejects(files.publish(stage, path.join(root, 'missing', 'published')), /ENOENT/);
  assert.equal(fs.existsSync(stage), true);
  const destination = path.join(root, 'destination'); fs.writeFileSync(destination, 'keep');
  await assert.rejects(files.copyVerified(source, destination, hash('original')), /EEXIST/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'keep');
});

for (const mode of ['mutate', 'replace', 'interrupt', 'replace-output']) test('copy rejects ' + mode + ' during streaming', async t => {
  const root = temporaryDirectory('copy-mutation-'), source = path.join(root, 'source'), target = path.join(root, 'stage');
  const bytes = Buffer.alloc(700 * 1024, 73); fs.writeFileSync(source, bytes);
  const files = await copyFiles(), open = fs.promises.open;
  let changed = false;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[0] === target) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async chunk => {
        await write(chunk);
        if (changed) return;
        changed = true;
        if (mode === 'interrupt') throw new Error('interrupted');
        if (mode === 'mutate') fs.appendFileSync(source, 'mutation');
        else {
          const file = mode === 'replace' ? source : target;
          fs.writeFileSync(file + '.replacement', bytes); fs.renameSync(file + '.replacement', file);
        }
      };
    }
    return handle;
  });
  await assert.rejects(files.copyVerified(source, target, hash(bytes)), /changed|differs|interrupted/);
  assert.equal(fs.existsSync(target), false);
});

// A previous session's records for `count` files whose identities differ from today's only in the
// inode number (or, with `change`, in another field), as on filesystems that renumber inodes.
function renumberedSession(prefix, count, { change, wrongHash } = {}) {
  const root = temporaryDirectory(prefix), records = {}, names = [];
  for (let index = 0; index < count; index++) {
    const file = path.join(root, 'file-' + index);
    fs.writeFileSync(file, 'content ' + index);
    const stat = fs.statSync(file, { bigint: true });
    const fields = [stat.dev, stat.ino + 1000003n, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs];
    if (change) fields[change] += 1n;
    records[file] = { identity: fields.join(':'),
      hash: wrongHash?.has(index) ? hash('other') : hash('content ' + index) };
    names.push(file);
  }
  const session = { data: { files: records }, checkpoint: async () => {}, dirty: 0 };
  session.markDirty = () => { ++session.dirty; };
  return { names, session };
}

test('records survive inode renumbering once a sample of files kept their hashes', async () => {
  const { names, session } = renumberedSession('renumbered-', 20);
  const files = await preparationFiles(session);
  for (const [index, file] of names.entries()) {
    assert.equal((await files.inspect(file)).hash, hash('content ' + index));
  }
  assert.equal(files.stats.hashedFiles, 8);
  assert.equal(files.stats.renumberedFiles, 12);
  assert.equal(files.stats.reusedFiles, 12);
  const second = renumberedSession('renumbered-sync-', 10);
  const syncFiles = await preparationFiles(second.session);
  for (const [index, file] of second.names.entries()) {
    assert.equal(syncFiles.inspectSync(file, Buffer.from('content ' + index)).hash, hash('content ' + index));
  }
  assert.equal(syncFiles.stats.hashedFiles, 8);
  assert.equal(syncFiles.stats.renumberedFiles, 2);
});

test('one changed file in the sample keeps full hashing for renumbered records', async () => {
  const { names, session } = renumberedSession('renumbered-changed-', 20, { wrongHash: new Set([3]) });
  const files = await preparationFiles(session);
  for (const [index, file] of names.entries()) {
    assert.equal((await files.inspect(file)).hash, hash('content ' + index));
  }
  assert.equal(files.stats.hashedFiles, 20);
  assert.equal(files.stats.renumberedFiles, 0);
});

test('records with other identity changes, or under hash verification, are hashed again', async () => {
  for (const change of [2, 3, 4]) {
    const { names, session } = renumberedSession('renumbered-other-' + change + '-', 12, { change });
    const files = await preparationFiles(session);
    for (const file of names) await files.inspect(file);
    assert.equal(files.stats.hashedFiles, 12, 'field ' + change);
  }
  const { names, session } = renumberedSession('renumbered-verify-', 12);
  const files = await preparationFiles(session, true);
  for (const file of names) await files.inspect(file);
  assert.equal(files.stats.hashedFiles, 12);
  assert.equal(files.stats.renumberedFiles, 0);
});

test('unchanged renumbered files keep their records so the saved state does not change', async () => {
  // File 3 changed (its recorded hash is stale); the others only had their inodes renumbered.
  const { names, session } = renumberedSession('renumbered-state-', 12, { wrongHash: new Set([3]) });
  const unchanged = names.filter((_, index) => index !== 3);
  const records = () => JSON.stringify(unchanged.map(file => session.data.files[file]));
  const before = records();
  const files = await preparationFiles(session);
  for (const file of names) await files.inspect(file);
  assert.equal(records(), before, 'verified inode-only changes leave records untouched');
  assert.equal(session.dirty, 1, 'only the changed file marks the state dirty');
  assert.equal(session.data.files[names[3]].hash, hash('content 3'), 'a changed file gets a new record');
});
