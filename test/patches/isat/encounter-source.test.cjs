'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const original = require('./test-fixtures/encounter-plugin.cjs');
const { createGraphics } = require('./test-fixtures/native-graphics.cjs');
let rewrite;
vm.runInNewContext(fs.readFileSync(require.resolve('../../../patches/isat/mpp-gpu-fragments.js'), 'utf8'), {
  PMJS: { isatSourcePatches: { register(file, _label, transform) {
    assert.equal(file, 'js/plugins/MPP_EncounterEffect.js');
    assert.equal(rewrite, undefined, 'encounter integration is one atomic transform');
    rewrite = transform;
  } }, optimizations: { register() {} }, phases: { on() {} } }
});

function load(source, { enabled = true, failCapture = false } = {}) {
  const graphics = createGraphics({ disables: enabled ? [] : ['plugins.mpp.gpu-fragments'] });
  const { context, hooks } = graphics;
  const trace = context.trace = { canvases: 0, bitmaps: 0, frames: 0, strokes: 0,
    clips: 0, samplers: 0, canvasBuilds: 0, random: [], durations: [], music: [] };
  context.failCapture = failCapture;
  context.SceneManager.snap = () => { trace.canvases++; return 'canvas'; };
  context.nextRandom = max => {
    trace.random.push(max);
    return [5, 2, 15][(trace.random.length - 1) % 3];
  };
  vm.runInContext(`Array.prototype.clone = function() { return this.slice(); };
    Math.randomInt = nextRandom;`, context);
  vm.runInContext(source, context);
  hooks.forEach(callback => callback());
  context.PMJS.optimizations.finalize();
  return { ...graphics, trace, scene: new context.fixture.Scene_Map(), ...context.fixture };
}

test('pristine encounter source rewrites atomically, preserves line endings and stays idempotent', () => {
  for (const source of [original, original.replace(/\n/g, '\r\n')]) {
    const output = rewrite(source);
    assert.notEqual(output, source);
    assert.doesNotThrow(() => new vm.Script(output));
    assert.equal(rewrite(output), null);
    assert.equal(output.includes('\r\n'), source.includes('\r\n'));
  }
});

test('missing or repeated snapshot call sites leave input untouched', () => {
  const call = 'EncounterEffect.setup(SceneManager.snap(), type)';
  for (const source of [original.replace(call, 'EncounterEffect.customSetup(image, type)'),
    original.replace(call, call + ';' + call),
    original.replace(/\}\)\(\);\s*$/, '')]) {
    assert.equal(rewrite(source), source);
  }
});

test('Canvas construction and extra break work come from the supplied source', () => {
  const source = original.replace('    const container = new Sprite();',
    '    trace.canvasBuilds += 2;\n    const container = new Sprite();')
    .replace('if (MPPlugin.LineWidth) this.bitmap._context.stroke();',
      'if (MPPlugin.LineWidth) trace.strokes += 3;');
  const output = rewrite(source);
  for (const enabled of [false, true]) {
    const h = load(output, { enabled });
    h.scene.launchBattle();
    h.effect.fragments()[0].onBreak([255, 0, 0], h.effect.snap, 12);
    assert.equal(h.trace.canvasBuilds || 0, enabled ? 0 : 3);
    assert.equal(h.trace.strokes, 3);
  }
});

test('native source path preserves geometry, random order, flash cadence and authored music timing', () => {
  const reference = load(original), native = load(rewrite(original));
  reference.scene.launchBattle(); native.scene.launchBattle();
  const expected = reference.effect.fragments()[0], actual = native.effect.fragments()[0];
  assert.deepEqual(native.trace.random, reference.trace.random);
  assert.deepEqual([actual.x, actual.y, actual.angle], [expected.x, expected.y, expected.angle]);
  assert.deepEqual([actual._isatSnapX, actual._isatSnapY], Array.from(expected.bitmap.source));
  assert.deepEqual(JSON.parse(JSON.stringify(actual._frame)), JSON.parse(JSON.stringify(expected._frame)));
  assert.equal(native.trace.bitmaps, 0);
  assert.equal(native.trace.frames, 0);
  assert.equal(native.context.__isatMppGpuFragmentStats.captures, 1);
  assert.equal(native.trace.samplers, reference.trace.samplers);
  assert.equal(native.trace.canvases, 0);
  assert.equal(actual._isatGpuSnap, native.effect.snap);
  assert.equal(native.scene.testSprite.__isatMppGpuPresentation, true);
  actual.onBreak([255, 0, 0], native.effect.snap, 12);
  expected.onBreak([255, 0, 0], 'canvas', 12);
  assert.deepEqual(native.trace.durations, reference.trace.durations);
  assert.equal(native.trace.strokes, 0);
  assert.equal(native.flashRate, reference.flashRate);
  native.scene.updateEncounterEffect(); reference.scene.updateEncounterEffect();
  assert.deepEqual(native.trace.music, reference.trace.music);
  native.effect.clear(); native.effect.clear();
  assert.equal(native.effect.snap.destroys, 1);
  assert.equal(native.effect.gpuFragments(), false);
});

test('disabled integration, capture errors and unsupported shapes retain authored Canvas behavior', () => {
  const variants = [
    [{ enabled: false }, () => {}], [{ failCapture: true }, () => {}],
    [{}, h => { h.params['Shape Type'] = 0; }], [{}, h => { h.params['Split X'] = 9; }],
    [{}, h => { h.params['Split Y'] = 5; }], [{}, h => { h.scene.type = 1; }],
    [{}, h => { h.scene.type = 2; }]
  ];
  for (const [options, configure] of variants) {
    const h = load(rewrite(original), options); configure(h); h.scene.launchBattle();
    assert.equal(h.effect.snap, 'canvas');
    assert.equal(h.effect.NeedClip, true);
    assert.notEqual(h.effect._isatGpuActive, true);
    assert.equal(h.trace.canvases, 1);
    assert.equal(h.trace.bitmaps, 1);
    assert.equal(h.trace.frames, 1);
    assert.equal(h.scene.testSprite.__isatMppGpuPresentation, undefined);
    h.effect.fragments()[0].onBreak([255, 0, 0], 'canvas', 12);
    assert.equal(h.trace.strokes, 1);
    assert.equal(h.trace.clips, 1);
  }
});

test('consecutive GPU and Canvas battles preserve clipping and snapshot ownership', () => {
  const h = load(rewrite(original));
  h.scene.launchBattle();
  const snapshot = h.effect.snap;
  assert.equal(h.effect.NeedClip, false);
  h.effect.clear();
  assert.equal(snapshot.destroys, 1);
  h.scene.type = 2;
  h.scene.launchBattle();
  assert.equal(h.effect.NeedClip, true);
  assert.equal(h.effect.snap, 'canvas');
  assert.equal(h.trace.canvasBuilds, 1);
  h.effect.clear();
  h.scene.type = 3;
  h.scene.launchBattle();
  assert.notEqual(h.effect.snap, snapshot);
  assert.equal(h.effect.NeedClip, false);
  assert.equal(h.context.__isatMppGpuFragmentStats.captures, 2);
  h.effect.clear();
  assert.equal(h.effect.snap.destroys, 1);
});

const referenceGame = process.env.PMJS_ISAT_REFERENCE_GAME;
test('purchased encounter plugin preserves geometry, randomness, flash and music through the complete map effect',
  { skip: !referenceGame }, () => {
    const fs = require('node:fs'), path = require('node:path');
    const source = fs.readFileSync(path.join(referenceGame, 'js/plugins/MPP_EncounterEffect.js'), 'utf8');
    const declarations = {};
    vm.runInNewContext(fs.readFileSync(path.join(referenceGame, 'js/plugins.js'), 'utf8'), declarations);
    const parameters = declarations.$plugins.find(plugin => plugin.name === 'MPP_EncounterEffect').parameters;
    const qualification = { PMJS: { phases: { on() {} } }, __pmjsBuiltinRequire: require };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../patches/isat/source-qualification.js'), 'utf8'), qualification);
    assert.equal(qualification.PMJS.isatSourceMatches('js/plugins/MPP_EncounterEffect.js', source), true);

    function reference(native) {
      const h = createGraphics(), c = h.context;
      let seed = 17, randoms = 0;
      c.random = () => { randoms++; seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      c.parameters = parameters;
      c.music = [];
      c.noop = () => {};
      c.Bitmap = function(width, height) {
        const bitmap = this;
        Object.assign(this, { width, height, canvas: {}, _setDirty: c.noop, _context: {
          drawImage(_image, x, y) { bitmap.source = [x, y]; }
        } });
        for (const method of ['save', 'restore', 'clip', 'stroke', 'translate', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'clearRect']) {
          this._context[method] = c.noop;
        }
      };
      Object.assign(c, {
        PluginManager: { parameters: () => parameters },
        Point: function(x, y) { Object.assign(this, { x, y }); }, Rectangle: c.PIXI.Rectangle,
        Utils: { isMobileDevice: () => false },
        $gameMap: { _interpreter: { isRunning: () => false } },
        $gamePlayer: { screenX: () => 40, screenY: () => 40 },
        $gameSystem: { getEncEffType: () => 3 }, ImageManager: { isReady: () => true },
        BattleManager: { playBattleBgm() { c.music.push(c.tick); } }
      });
      c.SceneManager.initialize = c.noop;
      c.SceneManager.snap = () => new c.Bitmap(c.Graphics.width, c.Graphics.height);
      vm.runInContext(`
        Number.prototype.clamp = function(min, max) { return Math.min(max, Math.max(min, Number(this))); };
        Array.prototype.clone = function() { return this.slice(); };
        String.prototype.format = function() { const args = arguments; return this.replace(/%([0-9]+)/g, (_, n) => args[Number(n) - 1]); };
        Math.random = random;
        Math.randomInt = max => Math.floor(Math.random() * max);
        function Game_System() {} function Game_Interpreter() {} function Sprite_Actor() {}
        function Scene_Base() { Sprite.call(this); }
        Scene_Base.prototype = Object.create(Sprite.prototype);
        function Scene_Map() { Scene_Base.call(this); this._windowLayer = {}; this._spriteset = {}; }
        Scene_Map.prototype = Object.create(Scene_Base.prototype);
        Scene_Map.prototype.snapForBattleBackground = noop;
        Scene_Map.prototype.launchBattle = function() { this._encounterEffectDuration = this.encounterEffectSpeed(); };
        function Scene_Battle() {}
        Sprite.prototype.update = noop;
        Sprite.prototype.setBlendColor = function(color) { this._blendColor = color.slice(); };
      `, c);
      const expose = 'globalThis.fixture = { effect: EncounterEffect, params: MPPlugin, Fragment: Encounter_Fragment };\n})();';
      vm.runInContext((native ? rewrite(source) : source).replace(/\}\)\(\);\s*$/, expose), c);
      c.SceneManager.initialize();
      const scene = new c.Scene_Map();
      scene.launchBattle();
      c.SceneManager._mppUpdateCount = 100;
      return { ...h, scene, effect: c.fixture.effect, randoms: () => randoms };
    }

    const authored = reference(false), native = reference(true);
    const pieces = h => h.effect.fragments().map(part => ({
      frame: part._frame, x: part.x, y: part.y, rotation: part.rotation(),
      scaleX: part.scaleX(), scaleY: part.scaleY(), visible: part.visible,
      source: part._isatGpuSnap ? [part._isatSnapX, part._isatSnapY] : part.bitmap.source
    }));
    const plain = value => JSON.parse(JSON.stringify(value));
    assert.ok(native.effect.fragments().length > 0);
    assert.deepEqual(plain(pieces(native)), plain(pieces(authored)));
    assert.equal(native.randoms(), authored.randoms());
    const snapshot = native.effect.snap, clip = authored.effect.NeedClip;
    assert.equal(native.effect.gpuFragments(), true);
    const speed = authored.effect.encounterEffectSpeed();
    for (let tick = 1; tick <= speed; tick++) {
      for (const h of [authored, native]) {
        h.context.tick = tick;
        h.scene.updateEncounterEffect();
        h.scene._encEffContainer.children.forEach(child => child.update());
      }
      assert.deepEqual(plain(pieces(native)), plain(pieces(authored)), 'fragment state at tick ' + tick);
      const colors = authored.scene._encEffContainer.children.map(child => child._blendColor);
      const accelerated = native.scene.testSprite._items.map(item => item.image._blendColor);
      assert.deepEqual(plain(accelerated), plain(colors), 'flash at tick ' + tick);
      assert.equal(native.randoms(), authored.randoms());
    }
    assert.deepEqual(native.context.music, authored.context.music);
    native.effect.clear(); native.effect.clear();
    assert.equal(snapshot.destroys, 1);
    assert.equal(native.context.__isatMppGpuFragmentStats.destroys, 1);
    native.scene.launchBattle();
    assert.equal(native.scene.testSprite._clipBackground, clip);
    native.effect.clear();
  });
