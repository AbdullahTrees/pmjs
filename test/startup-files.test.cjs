'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { startupFiles, runtimeIdentity } = require('../runner/startup-files.cjs');

test('startup receipts reuse unchanged bytes and rehash edits, replacements, upgrades and explicit verification', () => {
  const root = temporaryDirectory('startup-files-'), file = path.join(root, 'input');
  const receipt = path.join(root, 'receipt.json');
  fs.writeFileSync(file, 'first');
  const cold = startupFiles(receipt, 'generation');
  const first = cold.hash(file); cold.save();
  assert.equal(cold.stats.hashedBytes, 5);
  const warm = startupFiles(receipt, 'generation');
  assert.equal(warm.hash(file), first);
  assert.equal(warm.stats.hashedBytes, 0);
  const before = fs.statSync(file);
  fs.writeFileSync(file, 'other'); fs.utimesSync(file, before.atime, before.mtime);
  assert.notEqual(warm.hash(file), first, 'ctime invalidates restored mtime');
  fs.writeFileSync(file + '.new', 'third'); fs.renameSync(file + '.new', file);
  const third = warm.hash(file); warm.save();
  assert.notEqual(third, first);
  for (const [generation, verify] of [['upgrade', false], ['generation', true]]) {
    const checked = startupFiles(receipt, generation, verify);
    assert.equal(checked.hash(file), third); assert.equal(checked.stats.hashedBytes, 5);
  }
  fs.writeFileSync(receipt, '{');
  const repaired = startupFiles(receipt, 'generation');
  assert.equal(repaired.hash(file), third); assert.equal(repaired.stats.hashedBytes, 5);
});

test('runtime identity notices added and removed files while warm content reads remain zero', () => {
  const root = temporaryDirectory('runtime-identity-');
  for (const directory of ['js', 'profiles', 'tools']) fs.mkdirSync(path.join(root, directory));
  for (const file of ['js/base.js', 'profiles/base.json', 'tools/build-js-runtime.mjs',
    'tools/game-inspect.mjs', 'tools/achievement-discovery.mjs']) fs.writeFileSync(path.join(root, file), file);
  const receipt = path.join(root, 'receipt.json'), cold = startupFiles(receipt, 'build');
  const original = runtimeIdentity(root, cold.hash); cold.save();
  const warm = startupFiles(receipt, 'build');
  assert.equal(runtimeIdentity(root, warm.hash), original);
  assert.equal(warm.stats.hashedBytes, 0);
  fs.writeFileSync(path.join(root, 'js/added.js'), 'new');
  assert.notEqual(runtimeIdentity(root, warm.hash), original);
  fs.unlinkSync(path.join(root, 'js/added.js'));
  assert.equal(runtimeIdentity(root, warm.hash), original);
});

test('startup verification rejects mutation of an opened input', t => {
  const root = temporaryDirectory('startup-mutation-'), file = path.join(root, 'input');
  fs.writeFileSync(file, Buffer.alloc(512 * 1024));
  const read = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = read(...args);
    if (!changed) { changed = true; fs.appendFileSync(file, 'changed'); }
    return count;
  });
  const checked = startupFiles(path.join(root, 'receipt.json'), 'build');
  assert.throws(() => checked.hash(file), /changed while hashing/);
});
