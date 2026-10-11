'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function fixture({ ready = false, scale = true, configured = true, duringSetup = false } = {}) {
  const loaded = new Map(), phases = new Map(), events = [], bitmaps = [];
  const source = {
    width: ready ? 120 : 0, height: ready ? 80 : 0, ready, listeners: [],
    isReady() { return this.ready; },
    addLoadListener(callback) {
      assert.equal(events.at(-1), 'blur');
      if (this.ready) callback();
      else this.listeners.push(callback);
    },
    complete() {
      this.ready = true;
      this.width = 120;
      this.height = 80;
      this.listeners.splice(0).forEach(callback => callback());
    }
  };
  class Bitmap {
    constructor(width, height) {
      this.width = Math.max(width, 1);
      this.height = Math.max(height, 1);
      this.copies = [];
      bitmaps.push(this);
    }
    blt(...args) { if (args[3] > 0 && args[4] > 0) this.copies.push(args); }
  }
  class Scene_MenuBase {
    constructor() { this._menuBackgroundConstructorName = 'Scene_Menu'; this.children = []; }
    createBackground(argument) {
      events.push(['create', this, argument]);
      this.children.push({ snapshot: true, parent: this });
      if (!configured) return 'fallback';
      const sprite = this._backgroundSprite = {
        bitmap: new Bitmap(scale ? 816 : source.width, scale ? 624 : source.height),
        anchor: [0.5, 0.5], origin: [-408, -312], position: [408, 312],
        scale: [1.5, 1.5], filters: [{}], parent: this
      };
      sprite.bitmap.blt(source, 0, 0, source.width, source.height, 0, 0,
        sprite.bitmap.width, sprite.bitmap.height);
      this.children.push(sprite);
      events.push('motion', 'scale', 'blur');
      if (duringSetup) source.complete();
      return 'created';
    }
    terminate(argument) {
      events.push(['terminate', this, argument]);
      if (this.terminationError) throw this.terminationError;
      return 'terminated';
    }
  }
  const capturedTerminate = Scene_MenuBase.prototype.terminate;
  class Scene_Menu extends Scene_MenuBase {
    terminate(argument) { return capturedTerminate.call(this, argument); }
  }
  const context = { Bitmap, Scene_MenuBase, Scene_Menu, Graphics: { boxWidth: 816, boxHeight: 624 },
    SRD: { MenuBackgrounds: { scale, backgrounds: configured ? { Scene_Menu: '$test' } : {},
      loadImage(filename) { assert.equal(filename, '$test'); return source; } } },
    PMJS: { plugins: { onLoaded(name, owner, callback) { loaded.set(name, callback); } },
      phases: { on(name, owner, callback) { phases.set(name, callback); } } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/pmjs-plugins/srd/menu-backgrounds.js'), 'utf8'), context);
  return { ...context, source, loaded, phases, events, bitmaps,
    install() { loaded.get('SRD_MenuBackgrounds')(); phases.get('afterGuestPlugins')(); } };
}

test('installs only after the plugin and wraps the final guest methods', () => {
  const h = fixture();
  const original = h.Scene_MenuBase.prototype.createBackground;
  assert.equal(h.phases.size, 0);
  h.loaded.get('SRD_MenuBackgrounds')();
  assert.equal(h.Scene_MenuBase.prototype.createBackground, original);
  h.Scene_MenuBase.prototype.createBackground = function(argument) {
    h.events.push('later plugin');
    return original.call(this, argument);
  };
  h.phases.get('afterGuestPlugins')();
  const scene = new h.Scene_MenuBase();
  assert.equal(scene.createBackground('argument'), 'created');
  assert.equal(h.events[0], 'later plugin');
  assert.deepEqual(h.events[1], ['create', scene, 'argument']);
});

for (const scale of [true, false]) {
  test(`cold ${scale ? 'scaled' : 'unscaled'} source composes once after setup`, () => {
    const h = fixture({ scale });
    h.install();
    const scene = new h.Scene_MenuBase();
    scene.createBackground();
    const sprite = scene._backgroundSprite, empty = sprite.bitmap;
    const geometry = { anchor: sprite.anchor, origin: sprite.origin, position: sprite.position,
      scale: sprite.scale, filters: sprite.filters };
    assert.equal(empty.copies.length, 0);
    assert.equal(h.source.listeners.length, 1);
    const callback = h.source.listeners[0];
    h.source.complete();
    const composed = sprite.bitmap;
    assert.notEqual(composed, empty);
    assert.equal(composed.width, scale ? 816 : 120);
    assert.equal(composed.height, scale ? 624 : 80);
    assert.deepEqual(composed.copies, [[h.source, 0, 0, 120, 80, 0, 0,
      scale ? 816 : 120, scale ? 624 : 80]]);
    callback();
    assert.equal(sprite.bitmap, composed);
    assert.equal(h.bitmaps.length, 2);
    assert.equal(scene.children[0].snapshot, true);
    for (const key of Object.keys(geometry)) assert.equal(sprite[key], geometry[key]);
  });
}

test('warm source retains the original composition and allocation', () => {
  const h = fixture({ ready: true });
  h.install();
  const scene = new h.Scene_MenuBase();
  assert.equal(scene.createBackground(), 'created');
  assert.equal(scene._backgroundSprite.bitmap.copies.length, 1);
  assert.equal(h.bitmaps.length, 1);
  assert.equal(h.source.listeners.length, 0);
});

test('source completing during setup is composed through the immediate listener', () => {
  const h = fixture({ duringSetup: true });
  h.install();
  const scene = new h.Scene_MenuBase();
  scene.createBackground();
  assert.equal(scene._backgroundSprite.bitmap.copies.length, 1);
  assert.equal(h.source.listeners.length, 0);
});

test('unconfigured background preserves fallback and registers no work', () => {
  const h = fixture({ configured: false });
  h.install();
  assert.equal(new h.Scene_MenuBase().createBackground(), 'fallback');
  assert.equal(h.source.listeners.length, 0);
  assert.equal(h.bitmaps.length, 0);
});

for (const change of ['recreated', 'sprite replaced', 'bitmap replaced', 'reparented', 'terminated', 'termination throws']) {
  test(`${change} discards obsolete completion without releasing retained state`, () => {
    const h = fixture();
    h.install();
    const scene = new h.Scene_MenuBase();
    scene.createBackground();
    const sprite = scene._backgroundSprite, empty = sprite.bitmap;
    if (change === 'recreated') scene.createBackground();
    if (change === 'sprite replaced') scene._backgroundSprite = { bitmap: {} };
    if (change === 'bitmap replaced') sprite.bitmap = {};
    if (change === 'reparented') sprite.parent = {};
    if (change === 'terminated') {
      assert.equal(scene.terminate('exit'), 'terminated');
      assert.deepEqual(h.events.at(-1), ['terminate', scene, 'exit']);
      assert.equal(sprite.parent, scene);
    }
    if (change === 'termination throws') {
      scene.terminationError = new Error('guest failure');
      assert.throws(() => scene.terminate(), /guest failure/);
    }
    const retained = sprite.bitmap;
    h.source.complete();
    assert.equal(sprite.bitmap, retained);
    assert.equal(empty.copies.length, 0);
    if (change === 'recreated') assert.equal(scene._backgroundSprite.bitmap.copies.length, 1);
    else assert.equal(h.bitmaps.length, 1);
  });
}

test('unready or zero-size completions never publish a composed bitmap', () => {
  for (const ready of [false, true]) {
    const h = fixture();
    h.install();
    const scene = new h.Scene_MenuBase();
    scene.createBackground();
    const empty = scene._backgroundSprite.bitmap;
    h.source.ready = ready;
    h.source.listeners[0]();
    assert.equal(scene._backgroundSprite.bitmap, empty);
    assert.equal(h.bitmaps.length, 1);
  }
});

test('configured scene termination overrides that captured the old base discard completion', () => {
  const h = fixture();
  h.install();
  const scene = new h.Scene_Menu();
  scene.createBackground();
  const empty = scene._backgroundSprite.bitmap;
  assert.equal(scene.terminate('exit'), 'terminated');
  assert.deepEqual(h.events.at(-1), ['terminate', scene, 'exit']);
  h.source.complete();
  assert.equal(scene._backgroundSprite.bitmap, empty);
  assert.equal(h.bitmaps.length, 1);
});
