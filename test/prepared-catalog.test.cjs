'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { fingerprint, policyIdentity, sourceSetHash, readCatalog, writeCatalog, buildEntries } =
  require('../runner/prepared-catalog.cjs');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const processor = { version: { processor: 'images-test' }, lz4: 'lz4-test', codec: 'lz4' };
const policy = { recipes: [], astc: null, losslessPrefixes: [], workspaceBytes: 64, pageCodec: 'lz4', index: null };
const sources = ['img/pictures/a.png'];

function result(source, extra = {}) {
  return {
    version: 1,
    key: hash(source),
    source,
    sourceHash: hash('source:' + source),
    descriptor: { version: 1, width: 8, height: 8, halo: 1, pages: [{ path: 'page-0.pml4', width: 8, height: 8 }],
      cells: [{ rect: [0, 0, 8, 8], crop: [1, 1, 6, 6], page: 0, atlas: [1, 1, 6, 6], fill: [0, 0, 0, 0] }] },
    outputs: { 'page-0.pml4': hash('page:' + source) },
    ...extra
  };
}

function fixture(entries) {
  const root = temporaryDirectory('prepared-catalog-');
  const results = {};
  for (const [source, extra] of Object.entries(entries)) {
    const key = path.posix.join('entries', hash(source));
    results[key] = result(source, extra);
    fs.mkdirSync(path.join(root, key), { recursive: true });
  }
  return { root, results };
}

test('fingerprint covers image results, image failures and ignores maps', () => {
  const { results } = fixture({ 'img/pictures/a.png': {}, 'img/pictures/b.png': {} });
  results['maps/entries/x'] = { ...result('data/Map001.json'), source: '' };
  const before = fingerprint(results);
  assert.equal(fingerprint({ ...results }), before, 'fingerprint is stable');
  assert.equal(fingerprint({ 'maps/entries/x': results['maps/entries/x'] }), fingerprint({}),
    'map results do not affect the image fingerprint');
  assert.equal(fingerprint(results, { 'map:data/Map001.json': 'failed' }), before,
    'map failures do not affect the image fingerprint');
  assert.notEqual(fingerprint(results, { 'image:img/pictures/c.png': 'failed' }), before,
    'an image failure changes the fingerprint');
  const changed = { ...results };
  changed['entries/' + hash('img/pictures/a.png')] = { ...results['entries/' + hash('img/pictures/a.png')],
    outputs: { 'page-0.pml4': '0'.repeat(64) } };
  assert.notEqual(fingerprint(changed), before, 'a changed output changes the fingerprint');
});

test('source set hash covers added and removed image files', () => {
  assert.equal(sourceSetHash(sources), sourceSetHash([...sources]));
  assert.notEqual(sourceSetHash([...sources, 'img/pictures/c.png']), sourceSetHash(sources));
});

test('policy identity covers recipes, ASTC, lossless, workspace and the index file', () => {
  const root = temporaryDirectory('prepared-catalog-');
  const index = path.join(root, 'asset-index.json');
  fs.writeFileSync(index, '{"a":1}');
  const base = policyIdentity({ recipes: [], astc: { enabled: false }, losslessPrefixes: [], workspaceBytes: 64,
    pageCodec: 'lz4', assetIndexPath: index });
  assert.deepEqual(policyIdentity({ recipes: [], astc: { enabled: false }, losslessPrefixes: [], workspaceBytes: 64,
    pageCodec: 'lz4', assetIndexPath: index }), base, 'unchanged policy is stable');
  assert.notEqual(JSON.stringify(policyIdentity({ recipes: [{ source: 'img/a.png' }], astc: { enabled: false },
    losslessPrefixes: [], workspaceBytes: 64, pageCodec: 'lz4', assetIndexPath: index })), JSON.stringify(base),
  'a recipe change changes the policy');
  assert.notEqual(JSON.stringify(policyIdentity({ recipes: [], astc: { enabled: false }, losslessPrefixes: ['img/'],
    workspaceBytes: 64, pageCodec: 'lz4', assetIndexPath: index })), JSON.stringify(base),
  'a lossless change changes the policy');
  assert.notEqual(JSON.stringify(policyIdentity({ recipes: [], astc: { enabled: false }, losslessPrefixes: [],
    workspaceBytes: 128, pageCodec: 'lz4', assetIndexPath: index })), JSON.stringify(base),
  'a workspace change changes the policy');
  fs.writeFileSync(index, '{"a":22}');
  assert.notEqual(JSON.stringify(policyIdentity({ recipes: [], astc: { enabled: false }, losslessPrefixes: [],
    workspaceBytes: 64, pageCodec: 'lz4', assetIndexPath: index })), JSON.stringify(base),
  'a changed index file changes the policy');
});

test('catalog roundtrip installs prepared entries without touching sources', async () => {
  const { root, results } = fixture({ 'img/pictures/a.png': {} });
  const directory = path.join(root, 'entries', hash('img/pictures/a.png'));
  const entries = [{ source: 'img/pictures/a.png', directory, sourceIdentity: 'id:a', pageIdentities: ['page:a'] }];
  assert.equal(await writeCatalog({ root, results, sources, entries, processor, policy }), true);
  const catalog = await readCatalog(root);
  assert.equal(catalog.processor.codec, 'lz4');
  const built = buildEntries({ root, results, sources, failures: {}, catalog, processor, policy });
  assert.equal(built.length, 1);
  assert.equal(built[0].directory, directory);
  assert.equal(built[0].sourceIdentity, 'id:a');
  assert.deepEqual(built[0].pageIdentities, ['page:a']);
  assert.deepEqual(built[0].pageHashes, [results['entries/' + hash('img/pictures/a.png')].outputs['page-0.pml4']]);
  assert.equal(built[0].backingHash, results['entries/' + hash('img/pictures/a.png')].sourceHash);
});

test('stale or unreachable catalogs fall back to full validation', async () => {
  const { root, results } = fixture({ 'img/pictures/a.png': {} });
  const directory = path.join(root, 'entries', hash('img/pictures/a.png'));
  await writeCatalog({ root, results, sources,
    entries: [{ source: 'img/pictures/a.png', directory, sourceIdentity: 'id:a', pageIdentities: ['page:a'] }],
    processor, policy });
  const catalog = await readCatalog(root);

  assert.equal(buildEntries({ root, results, sources, catalog, processor: { ...processor, codec: 'png' }, policy }), null,
    'a processor change refuses the catalog');
  assert.equal(buildEntries({ root, results, sources, catalog, processor,
    policy: { ...policy, workspaceBytes: 128 } }), null, 'a policy change refuses the catalog');
  assert.equal(buildEntries({ root, results, sources: [...sources, 'img/pictures/c.png'], catalog, processor, policy }), null,
    'an added image source refuses the catalog');
  assert.equal(buildEntries({ root, results: { ...results, extra: result('img/pictures/b.png') }, sources, catalog, processor, policy }), null,
    'a changed result set refuses the catalog');
  assert.equal(buildEntries({ root, results, sources, catalog, processor, policy,
    failures: { 'image:img/pictures/a.png': 'failed' } }), null,
    'a failed image refuses the catalog so the full phase can repair it');
  assert.equal(buildEntries({ root, results: { ...results, ['entries/' + hash('img/pictures/a.png')]:
    { ...results['entries/' + hash('img/pictures/a.png')], failed: true } }, sources, catalog, processor, policy }), null,
    'an invalidated result refuses the catalog');

  const outside = await writeCatalog({ root, results, sources,
    entries: [{ source: 'img/pictures/a.png', directory: '/tmp', sourceIdentity: 'id:a', pageIdentities: ['page:a'] }],
    processor, policy });
  assert.equal(outside, true);
  assert.equal((await readCatalog(root)).entries['img/pictures/a.png'], undefined,
    'an entry outside the cache root is not written');
});

test('zero-page uniform images keep empty page identities', async () => {
  const { root, results } = fixture({ 'img/pictures/u.png': {
    descriptor: { version: 1, width: 4, height: 4, halo: 1, uniform: [1, 2, 3, 4], pages: [], cells: [] },
    outputs: {}
  } });
  const directory = path.join(root, 'entries', hash('img/pictures/u.png'));
  const uniformSources = ['img/pictures/u.png'];
  assert.equal(await writeCatalog({ root, results, sources: uniformSources,
    entries: [{ source: 'img/pictures/u.png', directory, sourceIdentity: 'id:u', pageIdentities: [] }],
    processor, policy }), true);
  const built = buildEntries({ root, results, sources: uniformSources, failures: {},
    catalog: await readCatalog(root), processor, policy });
  assert.equal(built.length, 1);
  assert.deepEqual(built[0].pageIdentities, []);
  assert.deepEqual(built[0].pageHashes, []);
});

test('a missing or malformed catalog read returns null', async () => {
  const root = temporaryDirectory('prepared-catalog-');
  assert.equal(await readCatalog(root), null);
  fs.writeFileSync(path.join(root, 'prepared-catalog.json'), '{not json');
  assert.equal(await readCatalog(root), null);
});
