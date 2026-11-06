'use strict';

// Prepared-asset caches must survive changes that do not change the prepared data:
// edits to the preparation modules, a moved game folder (with PMJS_PREPARATION_KEY), and
// switching between two runtime versions with different output formats.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { preparationLocks } = require('./helpers/preparation-lock.cjs');
const { openPreparation, preparationRoot, resultGeneration } = require('../runner/preparation-state.cjs');
const { signature } = require('../runner/preparation-catalog.cjs');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = letter => letter.repeat(64);
const image = (letter, processor) => ({ version: 1, key: key(letter), source: 'img/' + letter + '.png',
  sourceHash: key('0'), processor: { processor }, outputs: {} });

async function withEnv(name, value, run) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return await run(); } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
}

async function finishSession({ keep } = {}) {
  const base = temporaryDirectory('cache-stability-');
  const gameRoot = path.join(base, 'game'), cacheRoot = path.join(base, 'cache');
  fs.mkdirSync(gameRoot);
  fs.mkdirSync(cacheRoot);
  const root = path.join(fs.realpathSync(cacheRoot), 'preparation-v1', hash(fs.realpathSync(gameRoot)).slice(0, 16));
  const results = {
    ['entries/' + key('a')]: image('a', 'images-v1'),   // previous runtime version
    ['entries/' + key('b')]: image('b', 'images-v2'),   // current version, used this session
    ['entries/' + key('c')]: image('c', 'images-v2'),   // current version, source gone: stale
    ['entries/' + key('d')]: image('d', 'images-v0'),   // older runtime version
  };
  const generations = {
    [resultGeneration('entries/x', image('a', 'images-v1'))]: 2000,
    [resultGeneration('entries/x', image('d', 'images-v0'))]: 1000,
  };
  const data = { files: {}, results, indices: {}, failures: {}, generations };
  fs.mkdirSync(root, { recursive: true });
  for (const letter of 'abcd') {
    fs.mkdirSync(path.join(root, 'entries', key(letter)), { recursive: true });
    fs.writeFileSync(path.join(root, 'entries', key(letter), 'page.bin'), letter);
  }
  const output = path.join(root, 'entries', key('a'), 'page.bin');
  data.files[output] = { hash: 'kept-receipt' };
  fs.writeFileSync(path.join(root, 'preparation-state.json'), JSON.stringify({ version: 1, checksum: hash(data), data }));
  await withEnv('PMJS_PREPARATION_KEEP_GENERATIONS', keep, async () => {
    const session = await openPreparation({ gameRoot, cacheRoot, offline: true,
      native: { assets: preparationLocks(), fs: { inventory: () => [] } } });
    try {
      for (const phase of ['images', 'maps']) session.startPhase(phase);
      session.touch(path.join(root, 'entries', key('b')));
      for (const phase of ['images', 'maps']) session.finishPhase(phase, 'completed');
      await session.finish();
    } finally { await session.close(); }
  });
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'preparation-state.json'), 'utf8')).data;
  const present = [...'abcd'].filter(letter => fs.existsSync(path.join(root, 'entries', key(letter))));
  return { saved, present, output };
}

test('another runtime version keeps its prepared results; stale and older ones go', async () => {
  const { saved, present, output } = await finishSession();
  assert.deepEqual(present, ['a', 'b']);
  assert.deepEqual(Object.keys(saved.results).sort(), ['entries/' + key('a'), 'entries/' + key('b')]);
  assert.deepEqual(saved.files[output], { hash: 'kept-receipt' }, 'kept outputs keep their receipts');
  assert.equal(Object.keys(saved.generations).length, 2);
  assert.ok(saved.generations[resultGeneration('entries/x', image('b', 'images-v2'))] > 2000);
});

test('PMJS_PREPARATION_KEEP_GENERATIONS=0 restores single-version pruning', async () => {
  const { present } = await finishSession({ keep: '0' });
  assert.deepEqual(present, ['b']);
});

test('PMJS_PREPARATION_KEY names the per-game directory instead of the game path', async () => {
  const byPath = await withEnv('PMJS_PREPARATION_KEY', undefined, () => preparationRoot('/cache', '/games/one'));
  assert.equal(path.basename(byPath), hash('/games/one').slice(0, 16));
  const first = await withEnv('PMJS_PREPARATION_KEY', 'omori', () => preparationRoot('/cache', '/games/one'));
  const moved = await withEnv('PMJS_PREPARATION_KEY', 'omori', () => preparationRoot('/cache', '/elsewhere/two'));
  assert.equal(first, moved);
  assert.equal(path.basename(first), 'key-omori');
  await assert.rejects(withEnv('PMJS_PREPARATION_KEY', '../x', () => preparationRoot('/cache', '/g')), /invalid PMJS_PREPARATION_KEY/);
});

test('catalog signature ignores preparation module source text', () => {
  const native = { assets: { preparationVersion: { processor: 'images-v24' }, tilePreparationVersion: 'tiles-v4',
    preparationLz4Version: 'lz4-v3' } };
  const options = { native, images: true, maps: true, portDescriptors: [] };
  const before = signature(options);
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function(file, ...rest) {
    if (String(file).startsWith(path.join(__dirname, '..', 'runner'))) return Buffer.from('edited ' + Math.random());
    return readFileSync.call(this, file, ...rest);
  };
  try { assert.equal(signature(options), before); } finally { fs.readFileSync = readFileSync; }
  native.assets.preparationVersion = { processor: 'images-v25' };
  assert.notEqual(signature(options), before, 'an output-format change still invalidates');
});
