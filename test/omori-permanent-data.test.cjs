'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

// A stand-in for the guest fs: readFile records callbacks so the test can complete them later,
// as PMJS's scheduler does after the plugin script has returned.
function fixture(loadBody) {
  const pending = [];
  const guestFs = { readFile(file, callback) { pending.push({ file, callback }); } };
  const context = loadPmjsRuntime({ require: name => { assert.equal(name, 'fs'); return guestFs; },
    PluginManager: { loadScript(name) { return loadBody(name, guestFs); } } });
  const file = require.resolve('../js/pmjs-plugins/omori/permanent-data.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  context.PMJS.phases.emit('beforePlugins');
  return { context, guestFs, pending, originalReadFile: guestFs.readFile };
}

// GTP_OmoriFixes.js, Permanent_Manager.load(), on a fresh installation.
function omoriPermanentManagerLoad(guestFs) {
  guestFs.readFile('/save/OMORI/CUTSCENE.json', (err, data) => {
    if (err) { throw new Error(err); }
    return data;
  });
}

test('GTP_OmoriFixes cutscene read failures are logged like NW.js instead of escaping', t => {
  const logged = t.mock.method(console, 'error', () => {});
  const { context, guestFs, pending, originalReadFile } = fixture((name, guest) => {
    if (name === 'GTP_OmoriFixes.js') omoriPermanentManagerLoad(guest);
    return 'loaded';
  });
  assert.equal(context.PluginManager.loadScript('GTP_OmoriFixes.js'), 'loaded');
  assert.equal(guestFs.readFile, originalReadFile, 'fs.readFile is restored after the plugin loads');
  assert.equal(pending.length, 1);
  const missing = Object.assign(new Error('ENOENT: /save/OMORI/CUTSCENE.json'), { code: 'ENOENT' });
  assert.doesNotThrow(() => pending[0].callback(missing, null));
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(pending[0].callback(null, 'cutscenes'), 'cutscenes', 'successful reads still return');
});

test('other plugins keep fatal filesystem callback semantics', () => {
  const { context, pending } = fixture((name, guest) => {
    omoriPermanentManagerLoad(guest);
    return 'loaded';
  });
  context.PluginManager.loadScript('SomeOtherPlugin.js');
  assert.throws(() => pending[0].callback(new Error('ENOENT'), null), /ENOENT/);
});

test('fs.readFile is restored when GTP_OmoriFixes fails to load', () => {
  const { context, guestFs, originalReadFile } = fixture(() => { throw new Error('load failed'); });
  assert.throws(() => context.PluginManager.loadScript('GTP_OmoriFixes.js'), /load failed/);
  assert.equal(guestFs.readFile, originalReadFile);
});
