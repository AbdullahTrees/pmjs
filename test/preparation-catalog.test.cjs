'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { checksum, publishCatalog, readCatalog, retainedCatalogKeys } = require('../runner/preparation-catalog.cjs');

const rawChecksum = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function fixture(root) {
  const key = 'a'.repeat(64);
  const binding = { processor: 'v1' };
  const payload = { keys: [key], summary: { installed: 1 }, maps: [], index: {}, entries: [{ directory: path.join(root, 'entries', key),
    descriptor: { pages: [], cells: [], sources: [{ snapshot: path.join(root, 'maps/sources', key+'.png') }] } }] };
  return { key, binding, payload };
}
function writeV2(file, binding, payload) {
  return fs.writeFile(file, JSON.stringify({ version: 2, binding: checksum(binding), checksum: checksum(payload), payload }));
}
function mutatePayloadString(stored, mutate) {
  const payload = JSON.parse(stored);
  mutate(payload);
  return JSON.stringify(payload);
}

test('catalog diagnostics distinguish first launch, changed binding and damaged cache', async () => {
  const root = temporaryDirectory('pmjs-catalog-diagnostics-');
  const { binding, payload } = fixture(root);
  const file = path.join(root, 'catalog.json'), reasons = [];
  const read = selected => readCatalog(file, selected, root, reason => reasons.push(reason));
  assert.equal(await read(binding), null);
  assert.deepEqual(reasons.splice(0), ['missing']);
  await publishCatalog(file, binding, root, payload);
  assert.deepEqual(await read(binding), payload);
  assert.deepEqual(reasons, []);
  assert.equal(await read({ processor: 'v2' }), null);
  assert.deepEqual(reasons.splice(0), ['binding-mismatch']);
  const stored = JSON.parse(await fs.readFile(file));
  stored.checksum = 'damaged';
  await fs.writeFile(file, JSON.stringify(stored));
  assert.equal(await read(binding), null);
  assert.deepEqual(reasons.splice(0), ['integrity-mismatch']);
  await fs.writeFile(file, '{interrupted');
  assert.equal(await read(binding), null);
  assert.deepEqual(reasons, ['unreadable-or-invalid']);
});

test('catalog publication validates integrity, version, binding and cache paths', async () => {
  const root = temporaryDirectory('pmjs-catalog-');
  const { binding, payload } = fixture(root);
  const file = path.join(root, 'catalog.json');
  await publishCatalog(file, binding, root, payload);
  assert.equal(JSON.parse(await fs.readFile(file)).version, 3);
  assert.deepEqual(await readCatalog(file, binding, root), payload);
  assert.equal(await readCatalog(file, { processor: 'v2' }, root), null);
  const original = JSON.parse(await fs.readFile(file));
  for (const mutate of [c => { c.version++; }, c => { c.checksum = 'bad'; },
    c => { c.payload = mutatePayloadString(c.payload, p => { p.entries[0].directory = '../outside'; });
      c.checksum = rawChecksum(c.payload); },
    c => { c.payload = mutatePayloadString(c.payload, p => { p.entries[0].descriptor.sources[0].snapshot = '/tmp/page.png'; });
      c.checksum = rawChecksum(c.payload); }]) {
    const changed = structuredClone(original); mutate(changed);
    await fs.writeFile(file, JSON.stringify(changed));
    assert.equal(await readCatalog(file, binding, root), null);
  }
  await fs.writeFile(file+'.stage-'+process.pid, 'interrupted');
  await publishCatalog(file, binding, root, payload);
  assert.deepEqual(await readCatalog(file, binding, root), payload);
  assert.equal((await fs.readdir(root)).some(name => name.includes('.stage-')), false);
});

test('version 2 catalogs keep their fast path across the upgrade', async () => {
  const root = temporaryDirectory('pmjs-catalog-v2-');
  const { binding, payload } = fixture(root);
  const key = 'a'.repeat(64);
  // Version 2 files store root-relative paths, as the old publisher wrote them.
  const stored = structuredClone(payload);
  stored.entries[0].directory = 'entries/' + key;
  stored.entries[0].descriptor.sources[0].snapshot = 'maps/sources/' + key + '.png';
  const file = path.join(root, 'catalog.json');
  await writeV2(file, binding, stored);
  assert.deepEqual(await readCatalog(file, binding, root), payload);
  assert.equal(await readCatalog(file, { processor: 'v2' }, root), null);
  const original = JSON.parse(await fs.readFile(file));
  const changed = structuredClone(original);
  changed.payload.entries[0].directory = '../outside';
  changed.checksum = checksum(changed.payload);
  await fs.writeFile(file, JSON.stringify(changed));
  assert.equal(await readCatalog(file, binding, root), null);
});

test('retention understands version 2, version 3 and legacy index records', async () => {
  const key = 'b'.repeat(64), other = 'c'.repeat(64);
  assert.deepEqual(retainedCatalogKeys({ keys: [key], snapshots: [other] }), [key, other]);
  assert.deepEqual(retainedCatalogKeys({ payload: { keys: [key] } }), [key]);
  assert.deepEqual(retainedCatalogKeys({ payload: JSON.stringify({ keys: [key] }) }), [key]);
  assert.deepEqual(retainedCatalogKeys({ payload: '{damaged' }), []);
  assert.deepEqual(retainedCatalogKeys(null), []);
  assert.deepEqual(retainedCatalogKeys({ payload: { keys: ['nope'] } }), []);
});
