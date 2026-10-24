'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { temporaryDirectory } = require('../../helpers/temp.cjs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createStorage } = require('../../../runner/storage.cjs');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/auxiliary-storage.js'), 'utf8');
const encode = value => Buffer.from(value).toString('base64');

function slot(name, system = { _playtime: 3661000 }) {
  const actor = { _characterName: name, _characterIndex: 2, _faceName: name + 'Face',
    _faceIndex: 3, _hidden: false };
  return JSON.stringify({ system, party: { _actors: [2, 1], _maxBattleMembers: 2 },
    actors: { _data: [null, { ...actor, _hidden: true }, actor] } });
}

function setup(t, inputs = {}) {
  const root = temporaryDirectory('isat-auxiliary-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = createStorage(root);
  for (const [name, raw] of Object.entries(inputs)) storage.writeText(name, raw);
  const hooks = [], warnings = [], calls = [], configs = [];
  const context = vm.createContext({ NativeHost: { storage },
    console: { warn: message => warnings.push(message) },
    PMJS: { methods: { wrap: hook => hooks.push(hook) } },
    $dataSystem: { gameTitle: 'Test game' },
    $gameActors: { live: 'must not be replaced' },
    Graphics: { frameCount: 42 },
    JsonEx: { parse(json) {
      const result = JSON.parse(json);
      if (result && result.party) {
        result.party.maxBattleMembers = function() { return this._maxBattleMembers; };
      }
      return result;
    } },
    StorageManager: {
      localFilePath(id) {
        return '/save/' + (id < 0 ? 'settings.rpgsave' : id === 0 ? 'index.rpgsave' : 'file' + id + '.rpgsave');
      },
      exists(id) {
        const name = this.localFilePath(id).slice(6), host = context.NativeHost.storage;
        return host.exists(name) || (host.exists(name + '.bak') && !host.exists(name + '.deleted'));
      },
      load(id) {
        calls.push(id);
        const name = this.localFilePath(id).slice(6), host = context.NativeHost.storage;
        const raw = host.readText(name) ?? (host.exists(name + '.deleted') ? null : host.readText(name + '.bak'));
        return raw === null || raw === 'bad-compression' ? null : Buffer.from(raw, 'base64').toString();
      },
      save(id, json) { context.NativeHost.storage.writeText(this.localFilePath(id).slice(6), encode(json)); },
    },
    ConfigManager: {
      load() {
        calls.push('config caller');
        const json = context.StorageManager.load(-1);
        return this.applyData(json ? JSON.parse(json) : {});
      },
      applyData(value) { configs.push(value); return 'applied'; },
    },
    DataManager: {
      _globalId: 'RPGMV',
      maxSavefiles: () => 3,
      loadGlobalInfo() {
        calls.push('global caller');
        const json = context.StorageManager.load(0);
        const info = json ? JSON.parse(json) : [];
        for (let id = 1; id <= this.maxSavefiles(); id++) {
          if (!context.StorageManager.exists(id)) delete info[id];
        }
        return info;
      },
      saveGlobalInfo(info) { context.StorageManager.save(0, JSON.stringify(info)); },
    },
  });
  vm.runInContext(source, context);
  for (const hook of hooks) {
    const target = hook.getTarget(); target[hook.method] = hook.wrap(target[hook.method]);
  }
  return { context, storage, warnings, calls, configs };
}

test('missing and valid auxiliary records keep the effective caller behavior', t => {
  const empty = setup(t);
  assert.equal(empty.context.ConfigManager.load(), 'applied');
  assert.deepEqual(empty.configs, [{}]);
  assert.deepEqual(empty.context.DataManager.loadGlobalInfo(), []);
  assert.deepEqual(empty.warnings, []);
  const originalConfig = encode('{"volume":80}');
  const originalIndex = encode('[null,{"title":"saved","timestamp":1234}]');
  const good = setup(t, { 'settings.rpgsave': originalConfig, 'index.rpgsave': originalIndex,
    'file1.rpgsave': encode(slot('Saved')) });
  good.context.ConfigManager.load();
  assert.deepEqual(good.configs, [{ volume: 80 }]);
  assert.equal(good.context.DataManager.loadGlobalInfo()[1].timestamp, 1234);
  assert.ok(good.calls.includes('config caller'));
  assert.ok(good.calls.includes('global caller'));
  assert.equal(good.storage.readText('settings.rpgsave'), originalConfig);
  assert.equal(good.storage.readText('index.rpgsave'), originalIndex);
});

test('malformed settings are preserved uniquely and use the final default apply chain', t => {
  for (const raw of [encode('{broken'), encode('null'), encode('[]'), 'bad-compression']) {
    const { context: c, storage, configs, warnings } = setup(t, { 'settings.rpgsave': raw,
      'settings.rpgsave.corrupt': 'older malformed record' });
    assert.equal(c.ConfigManager.load(), 'applied');
    assert.equal(configs.length, 1);
    assert.equal(Object.keys(configs[0]).length, 0);
    assert.equal(storage.readText('settings.rpgsave'), raw);
    assert.equal(storage.readText('settings.rpgsave.corrupt'), 'older malformed record');
    assert.equal(storage.readText('settings.rpgsave.corrupt.1'), raw);
    assert.match(warnings[0], /Using the default settings/);
    c.ConfigManager.load();
    assert.equal(storage.readText('settings.rpgsave.corrupt.2'), null);
  }
});

test('bad save indexes recover real slots and metadata without changing game state or save bytes', t => {
  for (const raw of [encode('{broken'), encode('{}'), encode('null'), 'bad-compression']) {
    const first = encode(slot('First'));
    const second = encode(slot('Second', { _framesOnSave: 7320 }));
    const { context: c, storage, warnings } = setup(t, { 'index.rpgsave': raw,
      'file1.rpgsave': first, 'file2.rpgsave': second, 'file3.rpgsave': encode('{broken'),
      'file4.rpgsave': encode(slot('Outside')) });
    const info = c.DataManager.loadGlobalInfo();
    assert.equal(info.length, 3);
    assert.equal(info[1].title, 'Test game');
    assert.equal(info[1].globalId, 'RPGMV');
    assert.deepEqual(info[1].characters, [['First', 2]]);
    assert.deepEqual(info[1].faces, [['FirstFace', 3]]);
    assert.equal(info[1].playtime, '01:01:01');
    assert.equal(info[2].playtime, '00:02:02');
    assert.deepEqual(info[2].characters, [['Second', 2]]);
    assert.ok(Number.isFinite(info[1].timestamp));
    assert.equal(c.Graphics.frameCount, 42);
    assert.equal(c.$gameActors.live, 'must not be replaced');
    assert.equal(storage.readText('file1.rpgsave'), first);
    assert.equal(storage.readText('file2.rpgsave'), second);
    assert.equal(storage.readText('file3.rpgsave'), encode('{broken'));
    assert.equal(storage.readText('index.rpgsave.corrupt'), raw);
    assert.match(warnings[0], /Slot 3 could not be indexed/);
    assert.match(warnings[1], /Rebuilt missing save index entries/);
    assert.deepEqual(c.DataManager.loadGlobalInfo(), info);
  }
});

test('read, preservation, slot-read and repair-write failures stay visible and retain primary input', t => {
  const raw = encode('{broken');
  const failure = Object.assign(new Error('storage failure'), { code: 'EIO' });
  for (const which of ['read', 'preserve', 'slot', 'repair']) {
    const { context: c, storage } = setup(t, { 'index.rpgsave': raw, 'file1.rpgsave': encode(slot('One')) });
    const originalRead = storage.readText;
    const originalWrite = storage.writeText;
    c.NativeHost.storage = { ...storage,
      readText(name) {
        if (which === 'read' || (which === 'slot' && name === 'file1.rpgsave')) throw failure;
        return originalRead.call(storage, name);
      },
      writeText(name, value) {
        if (which === 'preserve' || (which === 'repair' && name === 'index.rpgsave')) throw failure;
        return originalWrite.call(storage, name, value);
      },
    };
    assert.throws(() => c.DataManager.loadGlobalInfo(), error => error === failure);
    assert.equal(storage.readText('index.rpgsave'), raw);
    assert.equal(storage.readText('file1.rpgsave'), encode(slot('One')));
  }
  const { context: c, storage, configs } = setup(t, { 'settings.rpgsave': raw });
  c.NativeHost.storage = { ...storage, writeText() { throw failure; } };
  assert.throws(() => c.ConfigManager.load(), error => error === failure);
  assert.equal(configs.length, 0);
  assert.equal(storage.readText('settings.rpgsave'), raw);
});

test('malformed backup-only auxiliary records retain the original backup during recovery', t => {
  const raw = encode('{broken');
  const { context: c, storage } = setup(t, { 'settings.rpgsave.bak': raw,
    'index.rpgsave.bak': raw, 'file1.rpgsave': encode(slot('Backup index')) });
  assert.equal(c.ConfigManager.load(), 'applied');
  assert.equal(storage.readText('settings.rpgsave'), null);
  assert.equal(storage.readText('settings.rpgsave.bak'), raw);
  assert.equal(storage.readText('settings.rpgsave.bak.corrupt'), raw);
  const info = c.DataManager.loadGlobalInfo();
  assert.equal(info[1].characters[0][0], 'Backup index');
  assert.equal(storage.readText('index.rpgsave.bak'), raw);
  assert.equal(storage.readText('index.rpgsave.bak.corrupt'), raw);
});

test('a missing or empty index discovers existing slots but leaves an empty save directory untouched', t => {
  const empty = setup(t);
  const generation = empty.storage.generation();
  assert.deepEqual(empty.context.DataManager.loadGlobalInfo(), []);
  assert.equal(empty.storage.generation(), generation);
  assert.equal(empty.storage.readText('index.rpgsave'), null);
  assert.deepEqual(empty.warnings, []);
  for (const index of [null, encode('[]')]) {
    const inputs = { 'file2.rpgsave': encode(slot('Recovered')) };
    if (index !== null) inputs['index.rpgsave'] = index;
    const { context: c, storage, warnings } = setup(t, inputs);
    const info = c.DataManager.loadGlobalInfo();
    assert.equal(info[2].characters[0][0], 'Recovered');
    assert.equal(info[1], undefined);
    assert.equal(storage.readText('file2.rpgsave'), inputs['file2.rpgsave']);
    assert.equal(storage.readText('index.rpgsave.corrupt'), null);
    const repaired = storage.readText('index.rpgsave');
    c.DataManager.loadGlobalInfo();
    assert.equal(storage.readText('index.rpgsave'), repaired);
    assert.equal(warnings.length, 1);
  }
});

test('stale index repair keeps existing metadata and adds only missing actual slots', t => {
  const retained = { title: 'Authored title', timestamp: 1234, playtime: '10:20:30',
    characters: [['Retained', 1]], faces: [['RetainedFace', 2]], pluginData: { progress: 17 } };
  const first = encode(slot('Should not replace retained'));
  const second = encode(slot('Newly indexed'));
  const { context: c, storage, calls } = setup(t, { 'index.rpgsave': encode(JSON.stringify([null, retained, 'bad entry'])),
    'file1.rpgsave': first, 'file2.rpgsave': second });
  const info = c.DataManager.loadGlobalInfo();
  assert.deepEqual(info[1], retained);
  assert.equal(info[2].characters[0][0], 'Newly indexed');
  assert.equal(calls.includes(1), false);
  assert.equal(storage.readText('file1.rpgsave'), first);
  assert.equal(storage.readText('file2.rpgsave'), second);
  const generation = storage.generation();
  assert.deepEqual(c.DataManager.loadGlobalInfo(), info);
  assert.equal(storage.generation(), generation);
});

test('early reads defer index reconstruction until the database is available', t => {
  for (const raw of [null, encode('{broken')]) {
    const inputs = { 'file1.rpgsave': encode(slot('Deferred')) };
    if (raw !== null) inputs['index.rpgsave'] = raw;
    const { context: c, storage, calls } = setup(t, inputs);
    c.$dataSystem = null;
    assert.equal(c.DataManager.loadGlobalInfo().length, 0);
    assert.equal(storage.readText('index.rpgsave'), raw);
    assert.equal(calls.includes(1), false);
    c.$dataSystem = { gameTitle: 'Loaded game' };
    const info = c.DataManager.loadGlobalInfo();
    assert.equal(info[1].title, 'Loaded game');
    assert.equal(info[1].characters[0][0], 'Deferred');
    assert.equal(storage.readText('file1.rpgsave'), inputs['file1.rpgsave']);
  }
});
