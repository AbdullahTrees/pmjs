'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { storageClassifier, mapStorageInputs } = require('../runner/asset-storage-index.cjs');

const decision = { version: 1, width: 1, height: 1, channels: 4, paletteBits: 0,
  source: [0, 1, 2, 3], swizzle: [0, 1, 2, 3] };

test('classification coalesces identical content and reuses only intact versioned decisions', async () => {
  const root = temporaryDirectory('storage-index-');
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  fs.writeFileSync(first, 'pixels'); fs.writeFileSync(second, 'pixels');
  let calls = 0;
  const assets = { imageStorageVersion: 1, async classifyImageStorage() { calls++; return decision; } };
  let classifier = storageClassifier(assets, root);
  assert.deepEqual(await Promise.all([classifier.classify(first), classifier.classify(second)]), [decision, decision]);
  assert.equal(calls, 1);
  classifier.save();
  classifier = storageClassifier(assets, root);
  assert.deepEqual(await classifier.classify(first), decision);
  assert.equal(calls, 1);
  fs.writeFileSync(first, 'changed');
  await classifier.classify(first);
  assert.equal(calls, 2);
  fs.writeFileSync(path.join(root, 'image-storage.json'), '{broken');
  await storageClassifier(assets, root).classify(second);
  assert.equal(calls, 3);
  assets.imageStorageVersion = 2;
  classifier.save();
  assets.imageStorageVersion = 3;
  await storageClassifier(assets, root).classify(second);
  assert.equal(calls, 4);
});

test('classification rejects inputs changed during a decode and retries failed work', async () => {
  const root = temporaryDirectory('storage-mutation-'), file = path.join(root, 'image');
  fs.writeFileSync(file, 'old');
  const assets = { imageStorageVersion: 1, async classifyImageStorage() {
    fs.writeFileSync(file, 'new'); return decision;
  } };
  const classifier = storageClassifier(assets, root);
  await assert.rejects(classifier.classify(file), /image changed/);
  assets.classifyImageStorage = async () => decision;
  assert.deepEqual(await classifier.classify(file), decision);
});

test('workers preserve order, bound concurrency and settle before reporting failure', async () => {
  let active = 0, peak = 0, finished = 0;
  const values = [0, 1, 2, 3, 4];
  const result = await mapStorageInputs(values, async value => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--; return value * 2;
  }, 2);
  assert.deepEqual(result, [0, 2, 4, 6, 8]);
  assert.equal(peak, 2);
  await assert.rejects(mapStorageInputs(values, async value => {
    await new Promise(resolve => setImmediate(resolve));
    finished++;
    if (value === 0) throw new Error('failed');
  }, 2), /failed/);
  assert.equal(finished, 2);
});
