'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');
const { createHostContext } = require('../../helpers/mz-host-context.cjs');
const { temporaryDirectory } = require('../../helpers/temp.cjs');
const directory = path.resolve(__dirname, '../../../patches/lookoutside');
const inventory = require('../../../patches/lookoutside/entry.json').modules;

test('the plugin-loading phase supplies a persistent refresher canvas through the native DOM', () => {
  const c = createHostContext({ runtime: { env: () => '', windowSize: () => ({ width: 816, height: 624 }) } },
    { graphics: false });
  vm.runInContext(fs.readFileSync(require.resolve('../../../js/pmjs-rpgmaker/lifecycle.js'), 'utf8'), c);
  for (const file of inventory) vm.runInContext(fs.readFileSync(path.join(directory, file), 'utf8'), c);
  assert.equal(c.document.getElementById('refresher'), null);
  c.PMJS.phases.emit('beforePlugins');
  const canvas = c.document.getElementById('refresher');
  assert.ok(canvas instanceof c.HTMLCanvasElement);
  assert.equal(canvas.parentNode, c.document.body);
  canvas.style.display = 'none';
  assert.equal(c.document.getElementById('refresher').style.display, 'none');
  canvas.style.display = 'block';
  c.PMJS.phases.emit('beforePlugins');
  c.PMJS.phases.emit('afterGuestPlugins');
  assert.equal(c.document.getElementById('refresher'), canvas);
  assert.equal(Array.from(c.document.getElementsByTagName('canvas')).filter(node => node.id === 'refresher').length, 1);
});

test('the MZ bundle includes the canvas patch only through explicit adapter selection', () => {
  const output = path.join(temporaryDirectory('pmjs-lookoutside-composition-'), 'bootstrap.js');
  function build(files) {
    execFileSync(process.execPath, [path.resolve(__dirname, '../../../tools/build-js-runtime.mjs'),
      '--profile', 'mz', ...files.flatMap(file => ['--adapter', path.join(directory, file)]), '--output', output]);
    const source = fs.readFileSync(output, 'utf8');
    assert.doesNotThrow(() => new vm.Script(source));
    return [...source.matchAll(/^\/\/ BEGIN (.+)$/gm)].map(match => match[1]);
  }
  const baseline = build([]);
  assert.ok(baseline.every(file => !inventory.includes(file)));
  const included = build(inventory);
  assert.deepEqual(included.filter(file => !baseline.includes(file)), inventory);
  assert.ok(included.indexOf('dom.js') < included.indexOf('js/pmjs-mz/bootstrap.js'));
});
