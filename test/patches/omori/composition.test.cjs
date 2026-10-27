'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');
const { temporaryDirectory } = require('../../helpers/temp.cjs');
const directory = path.resolve(__dirname, '../../../patches/omori');
const inventory = require('../../../patches/omori/entry.json').modules;

test('OMORI patches compose in manifest order only when selected', () => {
  const output = path.join(temporaryDirectory('pmjs-omori-composition-'), 'bootstrap.js');
  function build(files) {
    execFileSync(process.execPath, [path.resolve(__dirname, '../../../tools/build-js-runtime.mjs'),
      '--profile', 'mv', ...files.flatMap(file => ['--adapter', path.join(directory, file)]),
      '--output', output]);
    const source = fs.readFileSync(output, 'utf8');
    assert.doesNotThrow(() => new vm.Script(source));
    return [...source.matchAll(/^\/\/ BEGIN (.+)$/gm)].map(match => match[1]);
  }
  const baseline = build([]);
  assert.ok(baseline.every(file => !inventory.includes(file)));
  const selected = build(inventory);
  assert.deepEqual(selected.filter(file => !baseline.includes(file)), inventory);
  assert.ok(selected.indexOf('timing.js') < selected.indexOf('js/pmjs-mv/bootstrap.js'));
});
