'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { buildPortPreparation, verifyPortDescriptor, prepareForRun, reader, loadProcessor } =
  require('../runner/port-preparation.cjs');

const PROCESSOR_ID = 'fixture-prepared';
const TRANSFORM_PREFIX = Buffer.from('fixture-processed:', 'latin1');
const ACTIVE_SOURCE = 'sources/active.bin';
const DECLINED_SOURCE = 'sources/declined.bin';

const PROCESSOR_TEXT = `'use strict';
const prefix = Buffer.from(${JSON.stringify(TRANSFORM_PREFIX.toString('latin1'))}, 'latin1');
module.exports = {
  id: ${JSON.stringify(PROCESSOR_ID)}, version: 1,
  outputs: [
    { id: 'active', source: ${JSON.stringify(ACTIVE_SOURCE)},
      generate(bytes) { return Buffer.concat([prefix, bytes]); } },
    { id: 'declined', source: ${JSON.stringify(DECLINED_SOURCE)},
      generate() { return null; } },
  ],
};
`;

const HELPER_TEXT = `'use strict';
module.exports = {
  decorate(bytes) { return Buffer.concat([Buffer.from('from-helper:'), bytes]); },
};
`;
const MULTI_TEXT = `'use strict';
module.exports = {
  id: 'fixture-multi', version: 1, files: ['support.cjs'],
  outputs: [
    { id: 'composed', source: 'sources/active.bin',
      generate(bytes) { return require('./support.cjs').decorate(bytes); } },
  ],
};
`;
const REJECTING_PROCESSOR_TEXT = `'use strict';
module.exports = { id: 'fixture-rejected', version: 1, outputs: [] };
`;

function fixture() {
  const root = temporaryDirectory('pmjs-prepared-');
  const game = path.join(root, 'game');
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(path.join(game, 'sources'), { recursive: true });
  fs.mkdirSync(bundle);
  const processor = path.join(root, `${PROCESSOR_ID}.pmjs-processor.cjs`);
  fs.writeFileSync(processor, PROCESSOR_TEXT);
  const warnings = [];
  const logger = { warn: message => warnings.push(message) };
  return {
    root, game, bundle, processor, logger, warnings,
    source: name => path.join(game, ...name.split('/')),
    writeSources(active, declined) {
      fs.writeFileSync(this.source(ACTIVE_SOURCE), active);
      fs.writeFileSync(this.source(DECLINED_SOURCE), declined);
    },
    cache: () => path.join(root, 'cache'),
    bundledFile(record) { return path.join(bundle, ...record.file.split('/')); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('bundle includes only declared outputs and verification rejects tampering', () => {
  const f = fixture();
  try {
    f.writeSources('active-input', 'declined-input');
    const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle,
      processors: [f.processor], include: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].id, PROCESSOR_ID);
    assert.equal(records[0].processor, `preparation/${PROCESSOR_ID}/${PROCESSOR_ID}.pmjs-processor.cjs`);
    assert.equal(records[0].outputs.length, 2);
    const [active, declined] = records[0].outputs;
    assert.ok(active.file && active.sha256);
    assert.equal(declined.file, undefined);
    assert.equal(declined.sha256, undefined);
    assert.equal(verifyPortDescriptor(f.bundle, records).size, 1);
    const prepared = prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), descriptors: records, logger: f.logger });
    const artifact = reader(Object.fromEntries(prepared))(`${PROCESSOR_ID}/active`);
    assert.ok(Buffer.concat([TRANSFORM_PREFIX, Buffer.from('active-input')]).equals(artifact));
    assert.equal(reader(Object.fromEntries(prepared))('no-such-output'), null);
    fs.appendFileSync(f.bundledFile(records[0].outputs[0]), 'tampered');
    assert.throws(() => verifyPortDescriptor(f.bundle, records), /hash mismatch/);
  } finally { f.cleanup(); }
});

test('packaged-output damage falls back to local regeneration instead of failing the run', () => {
  const f = fixture();
  try {
    f.writeSources('active-input', 'declined-input');
    const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle,
      processors: [f.processor], include: true });
    fs.appendFileSync(f.bundledFile(records[0].outputs[0]), 'tampered');
    const prepared = prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), descriptors: records, logger: f.logger });
    assert.ok(Buffer.concat([TRANSFORM_PREFIX, Buffer.from('active-input')]).equals(
      reader(Object.fromEntries(prepared))(`${PROCESSOR_ID}/active`)),
      'regenerated locally despite damaged packaged bytes');
    assert.match(f.warnings.join('\n'), /packaged data unusable, regenerating locally/);
  } finally { f.cleanup(); }
});

test('without redistribution, bundling ships the processor only; the device builds cached output', () => {
  const f = fixture();
  try {
    f.writeSources('active-input', 'declined-input');
    const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle,
      processors: [f.processor], include: false });
    assert.equal(verifyPortDescriptor(f.bundle, records).size, 0);
    const prepared = prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), descriptors: records, logger: f.logger });
    assert.equal(prepared.has(`${PROCESSOR_ID}/declined`), false);
    const first = prepared.get(`${PROCESSOR_ID}/active`);
    assert.ok(Buffer.concat([TRANSFORM_PREFIX, Buffer.from('active-input')]).equals(
      reader(Object.fromEntries(prepared))(`${PROCESSOR_ID}/active`)));
    // A corrupted local cache is detected against its hash sidecar and rebuilt.
    fs.writeFileSync(first, 'corrupt');
    const rebuilt = prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), descriptors: records, logger: f.logger });
    assert.ok(Buffer.concat([TRANSFORM_PREFIX, Buffer.from('active-input')]).equals(
      reader(Object.fromEntries(rebuilt))(`${PROCESSOR_ID}/active`)),
      'corrupt local cache regenerated');
    // A changed source yields a distinct content-addressed artifact.
    const cached = rebuilt.get(`${PROCESSOR_ID}/active`);
    f.writeSources('different-input', 'declined-input');
    const second = prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), descriptors: records, logger: f.logger });
    assert.notEqual(second.get(`${PROCESSOR_ID}/active`), cached);
  } finally { f.cleanup(); }
});

test('selected adapter sidecars are discovered without a manifest and with missing game assets', () => {
  const f = fixture();
  try {
    const adapterDir = path.join(f.root, 'adapter');
    fs.mkdirSync(adapterDir);
    const adapter = path.join(adapterDir, 'adapter.js');
    fs.writeFileSync(adapter, '// adapter');
    fs.copyFileSync(f.processor, path.join(adapterDir, `${PROCESSOR_ID}.pmjs-processor.cjs`));
    const packaged = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle,
      adapters: [adapter], include: true });
    assert.equal(packaged.length, 1);
    assert.deepEqual(packaged[0].outputs, []);

    f.writeSources('device-input', 'declined-input');
    const prepared = prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), adapters: [adapter], logger: f.logger });
    assert.ok(reader(Object.fromEntries(prepared))(`${PROCESSOR_ID}/active`));
  } finally { f.cleanup(); }
});

test('declined outputs are remembered so later runs do not repeat the work', () => {
  const f = fixture();
  try {
    const processor = path.join(f.root, 'declined-counter.pmjs-processor.cjs');
    const counterPath = path.join(f.root, 'invocations.log');
    fs.writeFileSync(processor, `'use strict';
const fs = require('node:fs');
module.exports = {
  id: 'fixture-declined', version: 1,
  outputs: [
    { id: 'declined-source', source: ${JSON.stringify(DECLINED_SOURCE)},
      generate() { fs.appendFileSync(${JSON.stringify(counterPath)}, 'x\\n'); return null; } },
  ],
};
`);
    f.writeSources('anything', 'declined-input');
    const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle,
      processors: [processor], include: false });
    const log = () => {
      try { return (fs.readFileSync(counterPath, 'utf8').match(/x/g) || []).length; }
      catch { return 0; }
    };
    const first = prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), descriptors: records, logger: f.logger });
    assert.equal(first.has('fixture-declined/declined-source'), false);
    assert.equal(log(), 1);
    const second = prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), descriptors: records, logger: f.logger });
    assert.equal(second.has('fixture-declined/declined-source'), false);
    assert.equal(log(), 1, 'declined derivation not repeated');
    // New source content forces a fresh attempt.
    f.writeSources('anything', 'changed-content');
    prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), descriptors: records, logger: f.logger });
    assert.equal(log(), 2);
  } finally { f.cleanup(); }
});

test('declared support files travel with the processor and are verified', () => {
  const f = fixture();
  try {
    const processor = path.join(f.root, 'multi.cjs');
    fs.writeFileSync(path.join(f.root, 'support.cjs'), HELPER_TEXT);
    fs.writeFileSync(processor, MULTI_TEXT);
    f.writeSources('active-input', 'declined-input');

    const withData = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle,
      processors: [processor], include: true });
    assert.equal(withData[0].files[0].path, `preparation/fixture-multi/support.cjs`);
    assert.ok(reader(Object.fromEntries(prepareForRun({ gameRoot: f.game,
      bundleRoot: f.bundle, cacheRoot: f.cache(), descriptors: withData,
      logger: f.logger })))('fixture-multi/composed'));
    // Packaging corruption remains strict.
    const support = path.join(f.bundle, 'preparation/fixture-multi/support.cjs');
    fs.appendFileSync(support, 'tampered');
    assert.throws(() => verifyPortDescriptor(f.bundle, withData), /file hash mismatch/);

    // A recipient's device rebuilds from local cache via its own helper copy.
    const recipientBundle = path.join(f.root, 'bundle-recipient');
    fs.mkdirSync(recipientBundle);
    const withoutData = buildPortPreparation({ gameRoot: f.game, bundleRoot: recipientBundle,
      processors: [processor], include: false });
    const prepared = prepareForRun({ gameRoot: f.game, bundleRoot: recipientBundle,
      cacheRoot: f.cache(), descriptors: [withoutData[0]], logger: f.logger });
    assert.ok(Buffer.concat([Buffer.from('from-helper:'), Buffer.from('active-input')]).equals(
      reader(Object.fromEntries(prepared))('fixture-multi/composed')),
      'helper module resolved beside the packaged index');
  } finally { f.cleanup(); }
});

test('the packaged processor manifest may not diverge from the descriptor', () => {
  const f = fixture();
  try {
    f.writeSources('active-input', 'declined-input');
    fs.writeFileSync(f.source('sources/other.bin'), 'other-input');
    const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle,
      processors: [f.processor], include: false });
    const altered = JSON.parse(JSON.stringify(records));
    altered[0].outputs[0].source = 'sources/other.bin';
    altered[0].outputs[0].sourceSha256 =
      crypto.createHash('sha256').update(fs.readFileSync(f.source('sources/other.bin'))).digest('hex');
    const warnings = [];
    const prepared = prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle,
      cacheRoot: f.cache(), descriptors: altered, logger: { warn: message => warnings.push(message) } });
    assert.equal(prepared.has(`${PROCESSOR_ID}/active`), false);
    assert.match(warnings.join('\n'), /manifest changed/);
  } finally { f.cleanup(); }
});

test('declared sources must resolve inside the game and processors carry a valid manifest', () => {
  const f = fixture();
  try {
    const escaping = `'use strict';
module.exports = { id: 'fixture-escaping', version: 1,
  outputs: [{ id: 'outside', source: '../outside.bin', generate() { return null; } }] };
`;
    const processor = path.join(f.root, 'escaping.cjs');
    fs.writeFileSync(processor, escaping);
    fs.writeFileSync(path.join(f.root, 'outside.bin'), 'x');
    assert.throws(() => buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle,
      processors: [processor], include: false }), /invalid\/duplicate port output/);
    const rejecting = path.join(f.root, 'rejecting.cjs');
    fs.writeFileSync(rejecting, REJECTING_PROCESSOR_TEXT);
    assert.throws(() => loadProcessor(rejecting), /invalid port processor manifest/);
    assert.throws(() => loadProcessor(processor.replace('.cjs', '.js')), /.cjs file/);
  } finally { f.cleanup(); }
});

test('the derived-artifact cache stays bounded', () => {
  const f = fixture();
  try {
    const cacheRoot = f.cache();
    const dir = path.join(cacheRoot, 'port-preparation', PROCESSOR_ID);
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 136; index++) {
      const output = path.join(dir, `entry-${index}.pma1`);
      const bytes = Buffer.from(`payload-${index}`);
      fs.writeFileSync(output, bytes);
      fs.writeFileSync(`${output}.sha256`, crypto.createHash('sha256').update(bytes).digest('hex'));
    }
    f.writeSources('anything', 'declined-input');
    const records = buildPortPreparation({ gameRoot: f.game, bundleRoot: f.bundle,
      processors: [f.processor], include: false });
    prepareForRun({ gameRoot: f.game, bundleRoot: f.bundle, cacheRoot, descriptors: records,
      logger: f.logger });
    const leftovers = fs.readdirSync(dir).filter(name => name.endsWith('.pma1')).length;
    assert.ok(leftovers <= 128 && leftovers >= 127, 'cache accounts for decline markers and prunes overflow');
  } finally { f.cleanup(); }
});

test('a processor discovers asset types and formats without enumerating filenames', () => {
  const f = fixture();
  try {
    f.writeSources('active-input', 'declined-input');
    fs.mkdirSync(path.join(f.game, 'graphics'));
    fs.writeFileSync(path.join(f.game, 'graphics', 'one.png'), 'FAKEPNG-one');
    fs.writeFileSync(path.join(f.game, 'graphics', 'two.png'), 'FAKEPNG-two');
    fs.writeFileSync(path.join(f.game, 'graphics', 'three.png'), 'text-no');
    fs.writeFileSync(path.join(f.game, 'graphics', 'not-an-image.txt'), 'FAKEPNG-ignored');
    const processor = path.join(f.root, 'by-type.pmjs-processor.cjs');
    fs.writeFileSync(processor, `'use strict';
module.exports = {
  id: 'fixture-by-type', version: 1,
  discover({files, read}) {
    return files.filter(x => x.endsWith('.png') && read(x).subarray(0,7).toString() === 'FAKEPNG')
      .map(source => ({ source }));
  },
  generate(bytes, {id, source}) {
    return Buffer.from('ready:' + id + ':' + source + ':' + bytes.toString());
  }
};`);
    const records = buildPortPreparation({gameRoot:f.game, bundleRoot:f.bundle,
      processors:[processor], include:false});
    assert.deepEqual(records[0].outputs.map(x => x.id), ['one', 'two']);
    assert.deepEqual(records[0].outputs.map(x => x.source),
      ['graphics/one.png', 'graphics/two.png']);
    assert.equal(verifyPortDescriptor(f.bundle, records).size, 0);
    const data = prepareForRun({gameRoot:f.game, bundleRoot:f.bundle,
      cacheRoot:f.cache(), descriptors:records, logger:f.logger});
    assert.match(reader(data)('fixture-by-type/one').toString(),
      /^ready:one:graphics\/one.png:/);
    assert.match(reader(data)('fixture-by-type/two').toString(),
      /^ready:two:graphics\/two.png:/);
    assert.equal(data.size, 2);
  } finally { f.cleanup(); }
});

test('changing only a helper module invalidates an otherwise identical cached derivation', () => {
  const f = fixture();
  try {
    const processor = path.join(f.root, 'multi.cjs');
    const helper = path.join(f.root, 'support.cjs');
    fs.writeFileSync(processor, MULTI_TEXT);
    fs.writeFileSync(helper, `module.exports = { decorate(bytes) { return Buffer.concat([Buffer.from('OLD:'),bytes]); } };`);
    f.writeSources('source', 'unused');
    const aRoot = path.join(f.root,'bundle-A');
    const bRoot = path.join(f.root,'bundle-B');
    fs.mkdirSync(aRoot); fs.mkdirSync(bRoot);
    const a = buildPortPreparation({gameRoot:f.game, bundleRoot:aRoot, processors:[processor], include:false});
    const oldData = prepareForRun({gameRoot:f.game, bundleRoot:aRoot,cacheRoot:f.cache(),descriptors:a,logger:f.logger});
    assert.match(reader(oldData)('fixture-multi/composed').toString(), /^OLD:/);
    fs.writeFileSync(helper, `module.exports = { decorate(bytes) { return Buffer.concat([Buffer.from('NEW:'),bytes]); } };`);
    const b = buildPortPreparation({gameRoot:f.game, bundleRoot:bRoot, processors:[processor], include:false});
    const newData = prepareForRun({gameRoot:f.game, bundleRoot:bRoot,cacheRoot:f.cache(),descriptors:b,logger:f.logger});
    assert.match(reader(newData)('fixture-multi/composed').toString(), /^NEW:/);
    assert.notEqual(a[0].files[0].sha256,b[0].files[0].sha256);
    assert.notEqual(oldData.get('fixture-multi/composed'),newData.get('fixture-multi/composed'));
  } finally { f.cleanup(); }
});

test('no discovered files is a valid optional processor no-op', () => {
  const f = fixture();
  try {
    const processor = path.join(f.root,'discover-empty.pmjs-processor.cjs');
    fs.writeFileSync(processor, `module.exports={id:'fixture-empty',version:1,
      discover(){return []},generate(){throw new Error('must not run')}};`);
    const records = buildPortPreparation({gameRoot:f.game, bundleRoot:f.bundle,
      processors:[processor],include:true});
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].outputs, []);
  } finally { f.cleanup(); }
});

test('invalid optional manifests do not abort the game-preparation path', () => {
  const f = fixture();
  try {
    assert.equal(prepareForRun({gameRoot:f.game, bundleRoot:f.bundle,
      cacheRoot:f.cache(),descriptors:{invalid:true},logger:f.logger}).size,0);
    assert.equal(prepareForRun({gameRoot:f.game, bundleRoot:f.bundle,
      cacheRoot:f.cache(),descriptors:[null],logger:f.logger}).size,0);
    assert.match(f.warnings.join('\n'), /optional port preparation|<invalid>/);
  } finally { f.cleanup(); }
});
