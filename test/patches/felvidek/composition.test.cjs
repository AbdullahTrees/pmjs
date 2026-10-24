'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');
const { temporaryDirectory } = require('../../helpers/temp.cjs');
const { buildPortPreparation, discoverAdapterProcessors, verifyPortDescriptor } = require('../../../runner/port-preparation.cjs');
const directory = path.resolve(__dirname, '../../../patches/felvidek');
const inventory = require('../../../patches/felvidek/entry.json').modules;
const adapters = inventory.map(file => path.join(directory, file));

test('Felvidek patches are excluded by default and explicit adapters preserve inventory order', () => {
  assert.equal(new Set(inventory).size, inventory.length);
  const output = path.join(temporaryDirectory('pmjs-felvidek-composition-'), 'bootstrap.js');
  function build(files) {
    execFileSync(process.execPath, [path.resolve(__dirname, '../../../tools/build-js-runtime.mjs'),
      '--profile', 'mv', ...files.flatMap(file => ['--adapter', file]), '--output', output]);
    const source = fs.readFileSync(output, 'utf8');
    assert.doesNotThrow(() => new vm.Script(source));
    return [...source.matchAll(/^\/\/ BEGIN (.+)$/gm)].map(match => match[1]);
  }
  const baseline = build([]);
  assert.ok(baseline.every(name => !inventory.includes(name)));
  const included = build(adapters);
  assert.deepEqual(included.filter(name => !baseline.includes(name)), inventory);
  assert.ok(included.indexOf(inventory.at(-1)) < included.indexOf('js/pmjs-mv/bootstrap.js'));
});

test('the collision processor is discovered and packaged through the existing adapter mechanism', () => {
  const processor = path.join(directory, 'collision-map.pmjs-processor.cjs');
  assert.deepEqual(discoverAdapterProcessors([]), []);
  assert.deepEqual(discoverAdapterProcessors(adapters), [processor]);
  const bundleRoot = temporaryDirectory('pmjs-felvidek-processor-');
  const records = buildPortPreparation({ bundleRoot, adapters });
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'felvidek-collision');
  assert.deepEqual(fs.readFileSync(path.join(bundleRoot, records[0].processor)), fs.readFileSync(processor));
  assert.equal(verifyPortDescriptor(bundleRoot, records).size, 0);
});
