'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createStorage } = require('../../../runner/storage.cjs');
const { temporaryDirectory } = require('../../helpers/temp.cjs');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/persistent-storage.js'), 'utf8');
const encode = value => Buffer.from(value).toString('base64');
const record = value => JSON.stringify({ switches: [], variables: [value] });

function setup(t, inputs = {}) {
  const root = temporaryDirectory('isat-persistent-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = createStorage(root);
  for (const [name, raw] of Object.entries(inputs)) storage.writeText(name, raw);
  const hooks = [], warnings = [], messages = [], saves = [];
  const context = vm.createContext({ NativeHost: { storage },
    LZString: { compressToBase64: encode, decompressFromBase64: value =>
      value === 'invalid-compressed' ? null : Buffer.from(value, 'base64').toString() },
    console: { warn: message => warnings.push(message), error() {} },
    PMJS: { isatSourcePatches: { register() {} }, methods: { wrap: hook => hooks.push(hook) } },
    Scene_Boot: function Scene_Boot() {},
    $gameMessage: { add: message => messages.push(message) },
    SceneManager: { updateScene() {}, _sceneStarted: true },
    StorageManager: {
      localFileDirectoryPath() { return '/save/'; },
      localFilePath(id) { return '/save/file' + id + '.rpgsave'; },
      exists(id) { const name = this.localFilePath(id).slice(6);
        return storage.exists(name) || (storage.exists(name + '.bak') && !storage.exists(name + '.deleted')); },
      load(id) { const name = this.localFilePath(id).slice(6);
        const raw = storage.readText(name) ?? (storage.exists(name + '.deleted') ? null : storage.readText(name + '.bak'));
        return raw === null ? null : context.LZString.decompressFromBase64(raw); },
      save(id, json) {
        saves.push({ id, json });
        context.NativeHost.storage.writeText(this.localFilePath(id).slice(6), encode(json));
        return this.saveResult;
      }
    }
  });
  context.SceneManager._scene = new context.Scene_Boot();
  vm.runInContext(source, context);
  for (const hook of hooks) {
    const target = hook.getTarget(); target[hook.method] = hook.wrap(target[hook.method]);
  }
  return { context, storage, warnings, messages, saves };
}

test('unchanged persistent records reuse a successful result while changed and ordinary saves still write', t => {
  const { context: c, storage, saves } = setup(t);
  c.StorageManager.saveResult = true;
  assert.equal(c.StorageManager.save('Persistent', record(3)), true);
  const generation = storage.generation();
  assert.equal(c.StorageManager.save('Persistent', record(3)), true);
  assert.equal(saves.length, 1);
  assert.equal(storage.generation(), generation);
  assert.equal(storage.readText('persistent.rpgsave'), encode(record(3)));
  c.StorageManager.save('Persistent', record(4));
  assert.equal(saves.length, 2);
  assert.equal(storage.readText('persistent.rpgsave'), encode(record(4)));
  c.StorageManager.save(1, record(4));
  c.StorageManager.save(1, record(4));
  assert.equal(saves.length, 4);
});

test('failed changed records invalidate previous success and both old and new payloads can retry', t => {
  const { context: c, storage, saves } = setup(t);
  c.StorageManager.save('Persistent', record(3));
  const write = storage.writeText;
  storage.writeText = () => { throw new Error('ENOSPC'); };
  assert.equal(c.StorageManager.save('Persistent', record(4)), false);
  storage.writeText = write;
  c.StorageManager.save('Persistent', record(3));
  assert.equal(saves.length, 3);
  c.StorageManager.save('Persistent', record(4));
  assert.equal(storage.readText('persistent.rpgsave'), encode(record(4)));
  c.StorageManager.saveResult = false;
  c.StorageManager.save('Persistent', record(5));
  c.StorageManager.save('Persistent', record(5));
  assert.equal(saves.length, 6);
});

test('loads including failed loads invalidate the last successful persistent write', t => {
  const { context: c, storage, saves } = setup(t);
  c.StorageManager.save('Persistent', record(3));
  assert.equal(c.StorageManager.load('Persistent'), record(3));
  c.StorageManager.save('Persistent', record(3));
  assert.equal(saves.length, 2);
  const read = storage.readText;
  storage.readText = () => { throw new Error('EIO'); };
  assert.throws(() => c.StorageManager.load('Persistent'), /EIO/);
  storage.readText = read;
  c.StorageManager.save('Persistent', record(3));
  assert.equal(saves.length, 3);
});

test('storage mutations, backend replacement and changed filenames cannot reuse stale success', t => {
  const { context: c, storage, saves } = setup(t);
  const json = record(3);
  c.StorageManager.save('Persistent', json);
  for (const mutate of [
    () => storage.remove('persistent.rpgsave'),
    () => storage.writeText('persistent.rpgsave', encode(record(4))),
    () => { storage.writeText('restore.rpgsave', encode(record(5))); storage.rename('restore.rpgsave', 'persistent.rpgsave'); }
  ]) {
    mutate();
    const count = saves.length;
    c.StorageManager.save('Persistent', json);
    assert.equal(saves.length, count + 1);
    assert.equal(storage.readText('persistent.rpgsave'), encode(json));
  }
  c.NativeHost.storage = { ...storage };
  c.StorageManager.save('Persistent', json);
  assert.equal(saves.length, 5);
  c.StorageManager.localFilePath = () => '/save/other-persistent.rpgsave';
  c.StorageManager.save('Persistent', json);
  assert.equal(saves.length, 6);
  assert.equal(storage.readText('other-persistent.rpgsave'), encode(json));
});

test('without storage generations each persistent call delegates and preserves undefined results', t => {
  const { context: c, storage, saves } = setup(t);
  c.NativeHost.storage = { ...storage, generation: undefined };
  assert.equal(c.StorageManager.save('Persistent', record(3)), undefined);
  assert.equal(c.StorageManager.save('Persistent', record(3)), undefined);
  assert.equal(saves.length, 2);
});

test('loads existing canonical progress and migrates a previous native filename without deleting it', t => {
  const raw = encode(record(3));
  const { context: c, storage } = setup(t, { 'filePersistent.rpgsave': raw });
  assert.equal(c.StorageManager.load('Persistent'), record(3));
  assert.equal(storage.readText('persistent.rpgsave'), raw);
  assert.equal(storage.readText('filePersistent.rpgsave'), raw);
  c.StorageManager.save('Persistent', record(4));
  assert.equal(c.StorageManager.load('Persistent'), record(4));
  assert.equal(storage.readText('filePersistent.rpgsave'), raw);
  const existing = setup(t, { 'persistent.rpgsave': raw });
  assert.equal(existing.context.StorageManager.load('Persistent'), record(3));
  assert.deepEqual(existing.warnings, []);
});

test('canonical progress wins a conflict, preserves both inputs and discloses the choice', t => {
  const canonical = encode(record(2)), legacy = encode(record(3));
  const { context: c, storage, warnings, messages } = setup(t,
    { 'persistent.rpgsave': canonical, 'filePersistent.rpgsave': legacy });
  assert.equal(c.StorageManager.load('Persistent'), record(2));
  assert.equal(storage.readText('persistent.rpgsave'), canonical);
  assert.equal(storage.readText('filePersistent.rpgsave'), legacy);
  assert.equal(warnings.length, 1);
  c.SceneManager.updateScene(); assert.equal(messages.length, 0);
  c.$gameMessage = { add: message => messages.push(message) };
  c.SceneManager._scene = {}; c.SceneManager.updateScene();
  assert.equal(messages.length, 1); assert.match(messages[0], /Different persistent/);
  c.SceneManager.updateScene(); assert.equal(messages.length, 1);
});

test('an imported previous record does not conflict with newer canonical progress on restart', t => {
  const legacy = encode(record(3));
  const { context: c, warnings } = setup(t, { 'persistent.rpgsave': encode(record(4)),
    'filePersistent.rpgsave': legacy, 'filePersistent.rpgsave.imported': legacy });
  assert.equal(c.StorageManager.load('Persistent'), record(4));
  assert.deepEqual(warnings, []);
});

test('bad JSON, bad record shape and failed decompression preserve bytes before recovery', t => {
  for (const raw of [encode('{broken'), encode('null'), encode('{"variables":3}'), 'invalid-compressed']) {
    const { context: c, storage, warnings } = setup(t, { 'persistent.rpgsave': raw,
      'persistent.rpgsave.corrupt': 'previous corruption' });
    const json = c.StorageManager.load('Persistent');
    assert.deepEqual(JSON.parse(json), { switches: [], variables: [] });
    assert.equal(storage.readText('persistent.rpgsave.corrupt'), 'previous corruption');
    assert.equal(storage.readText('persistent.rpgsave.corrupt.1'), raw);
    assert.equal(c.StorageManager.load('Persistent'), json);
    assert.equal(warnings.length, 1);
  }
});

test('recovers a valid backup before resetting progress and preserves a malformed legacy import', t => {
  const broken = encode('{broken'), good = encode(record(3));
  const { context: c, storage, warnings } = setup(t, { 'persistent.rpgsave': broken,
    'persistent.rpgsave.bak': good });
  assert.equal(c.StorageManager.load('Persistent'), record(3));
  assert.equal(storage.readText('persistent.rpgsave.corrupt'), broken);
  assert.equal(storage.readText('persistent.rpgsave.bak'), good);
  assert.match(warnings[0], /Restored/);
  const migrated = setup(t, { 'filePersistent.rpgsave': broken });
  assert.doesNotThrow(() => JSON.parse(migrated.context.StorageManager.load('Persistent')));
  assert.equal(migrated.storage.readText('filePersistent.rpgsave'), broken);
  assert.equal(migrated.storage.readText('persistent.rpgsave.corrupt'), broken);
});

test('missing or deliberately deleted persistent progress does not revive a stale native record', t => {
  const empty = setup(t); assert.equal(empty.context.StorageManager.load('Persistent'), null);
  const { context: c, storage } = setup(t, { 'filePersistent.rpgsave': encode(record(3)),
    'persistent.rpgsave.deleted': '' });
  assert.equal(c.StorageManager.load('Persistent'), null);
  assert.equal(storage.readText('persistent.rpgsave'), null);
});

test('failed preservation and migration leave originals intact and expose storage errors', t => {
  const raw = encode('{broken'); const failure = new Error('ENOSPC');
  for (const filename of ['persistent.rpgsave', 'filePersistent.rpgsave']) {
    const { context: c, storage } = setup(t, { [filename]: raw });
    c.NativeHost.storage = { ...storage, writeText() { throw failure; } };
    assert.throws(() => c.StorageManager.load('Persistent'), error => error === failure);
    assert.equal(storage.readText(filename), raw);
  }
});

test('persistent save failure returns false and is visible; other save failures still throw', t => {
  const { context: c, messages } = setup(t);
  const failure = new Error('EACCES');
  c.NativeHost.storage.writeText = () => { throw failure; };
  assert.equal(c.StorageManager.save('Persistent', record(3)), false);
  c.SceneManager._scene = {}; c.SceneManager.updateScene();
  assert.match(messages[0], /could not be saved/);
  assert.throws(() => c.StorageManager.save(1, record(3)), error => error === failure);
});


test('valid canonical progress remains readable on read-only storage even with a conflicting legacy record', t => {
  const { context: c, storage } = setup(t, { 'persistent.rpgsave': encode(record(2)),
    'filePersistent.rpgsave': encode(record(3)) });
  c.NativeHost.storage = { ...storage, writeText() { throw new Error('EROFS'); } };
  assert.equal(c.StorageManager.load('Persistent'), record(2));
});

test('valid previous native progress recovers a corrupt canonical record before a reset', t => {
  const broken = encode('{broken'), legacy = encode(record(3));
  const { context: c, storage, warnings } = setup(t, { 'persistent.rpgsave': broken,
    'filePersistent.rpgsave': legacy });
  assert.equal(c.StorageManager.load('Persistent'), record(3));
  assert.equal(storage.readText('persistent.rpgsave.corrupt'), broken);
  assert.equal(storage.readText('filePersistent.rpgsave'), legacy);
  assert.match(warnings[0], /previous native record/);
});
