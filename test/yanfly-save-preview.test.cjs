'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function fixture() {
  const timers = new Map(), images = new Map(), draws = [], warnings = [];
  let serial = 0;
  function schedule(callback, delay) {
    assert.equal(delay, 50); timers.set(++serial, callback); return serial;
  }
  function image(name) {
    if (!images.has(name)) images.set(name, { width: 0, failed: false,
      isError() { return this.failed; } });
    return images.get(name);
  }
  class Window_SaveInfo {
    constructor() { this.parent = {}; this.contents = {}; this.slot = 1; }
    savefileId() { return this.slot; }
    updateIndex() { return 'index'; }
    refresh() { if (this.onRefresh) this.onRefresh(); return 'refresh'; }
  }
  for (const name of ['drawCharacter', 'drawFace', 'drawSvActor']) {
    Window_SaveInfo.prototype[name] = function(...args) {
      const bitmap = image(name === 'drawSvActor' ? args[0].battlerName() : args[0]);
      if (!bitmap.width) return schedule(() => this[name](...args), 50);
      draws.push({ window: this, name, args }); return 'drawn';
    };
  }
  class Scene_File {
    onActionCancel() {}
    onConfirmCancel() {}
    terminate() { return 'terminated'; }
  }
  const scene = new Scene_File(), SceneManager = { _scene: scene, changing: false,
    isSceneChanging() { return this.changing; } };
  const context = vm.createContext({ Window_SaveInfo, Scene_File, SceneManager,
    ImageManager: { loadCharacter: image, loadFace: image, loadSvActor: image },
    console: { warn(message) { warnings.push(message); } },
    setTimeout: schedule,
    clearTimeout(id) { timers.delete(id); },
    PMJS: { plugins: { onLoaded(_plugin, _owner, install) { install(); } } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-plugins/yanfly/save-core.js'), 'utf8'), context);
  const window = scene._infoWindow = new Window_SaveInfo();
  return { window, scene, SceneManager, timers, images, image, draws, warnings,
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); } };
}

test('each delayed party image draws once with its original receiver and arguments', () => {
  const h = fixture(), actor = { battlerName() { return 'sv'; } };
  h.window.drawCharacter('character', 2, 10, 20);
  h.window.drawFace('face', 3, 30, 40, 96, 80);
  h.window.drawSvActor(actor, 50, 60);
  assert.equal(h.timers.size, 3);
  assert.equal(h.draws.length, 0);
  for (const image of h.images.values()) image.width = 144;
  h.tick();
  assert.deepEqual(h.draws.map(d => d.args), [['character', 2, 10, 20],
    ['face', 3, 30, 40, 96, 80], [actor, 50, 60]]);
  assert.ok(h.draws.every(d => d.window === h.window));
  assert.equal(h.timers.size, 0);
});

test('ready portraits retain the immediate draw result without a timer', () => {
  const h = fixture();
  h.image('ready').width = 144;
  assert.equal(h.window.drawFace('ready', 0, 1, 2), 'drawn');
  assert.equal(h.timers.size, 0);
});

test('evicted completed images cannot escape the retry budget or cancellation', () => {
  const h = fixture();
  h.window.drawFace('portrait', 0, 1, 2);
  h.image('portrait').width = 144;
  h.images.delete('portrait');
  h.tick();
  assert.equal(h.draws.length, 0);
  assert.equal(h.timers.size, 1);
  const late = [...h.timers.values()][0];
  h.window.updateIndex();
  assert.equal(h.timers.size, 0);
  h.image('portrait').width = 144;
  late();
  assert.equal(h.draws.length, 0);
});

for (const change of ['slot', 'contents', 'detach', 'scene', 'transition', 'failure', 'terminate']) {
  test('delayed portrait cannot paint after ' + change, () => {
    const h = fixture();
    h.window.drawFace('old', 0, 1, 2);
    const late = [...h.timers.values()][0];
    if (change === 'slot') h.window.slot = 2;
    if (change === 'contents') h.window.contents = {};
    if (change === 'detach') h.window.parent = null;
    if (change === 'scene') {
      h.SceneManager._scene = {};
      h.window.savefileId = () => { throw new Error('must check scene first'); };
    }
    if (change === 'transition') h.SceneManager.changing = true;
    if (change === 'failure') h.image('old').failed = true;
    if (change === 'terminate') assert.equal(h.scene.terminate(), 'terminated');
    h.image('old').width = 144;
    h.tick(); late();
    assert.equal(h.draws.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('slot A to B to A and same-slot refresh invalidate old callbacks', () => {
  for (const sameSlot of [false, true]) {
    const h = fixture();
    h.window.drawFace('old', 0, 1, 2);
    const stale = [...h.timers.values()][0];
    if (!sameSlot) {
      h.window.slot = 2; h.window.updateIndex();
      h.window.slot = 1; h.window.updateIndex();
    }
    h.window.onRefresh = () => h.window.drawFace('new', 0, 1, 2);
    assert.equal(h.window.refresh(), 'refresh');
    h.image('old').width = h.image('new').width = 144;
    stale(); h.tick();
    assert.deepEqual(h.draws.map(d => d.args[0]), ['new']);
  }
});

test('each failed-load budget ends after 60 retries and leaves no timers', () => {
  const h = fixture();
  h.window.drawFace('never', 0, 1, 2);
  for (let i = 0; i < 59; i++) h.tick();
  assert.equal(h.timers.size, 1);
  h.window.drawFace('later', 0, 1, 2);
  h.tick();
  assert.equal(h.warnings.length, 1);
  assert.equal(h.timers.size, 1);
  h.image('later').width = 144;
  h.tick();
  assert.deepEqual(h.draws.map(d => d.args[0]), ['later']);
  assert.equal(h.timers.size, 0);
});

test('hidden windows still receive their portrait and known failures do not retry', () => {
  const h = fixture();
  h.window.visible = false;
  h.window.drawFace('hidden', 0, 1, 2);
  h.image('hidden').width = 144;
  h.tick();
  assert.equal(h.draws.length, 1);
  h.image('failed').failed = true;
  h.window.drawFace('failed', 0, 1, 2);
  assert.equal(h.timers.size, 0);
});
