'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/battle-hidden-gauges.js'), 'utf8');

function fixture() {
  function Window() { this.visible = true; this.contentsOpacity = 0; this.updates = 0; }
  Window.prototype.update = function() { this.updates++; return 'ordinary'; };
  function HP() { Window.call(this); } HP.prototype = Object.create(Window.prototype);
  function ATB() { Window.call(this); } ATB.prototype = Object.create(Window.prototype);
  const context = { Window_VisualHPGauge: HP, Window_EnemyVisualATB: ATB, $gameTroop: { _troopId: 26 },
    PMJS: { isatSourceQualification: { verified: true }, phases: { on(phase, name, callback) { callback(); } } } };
  vm.runInNewContext(source, context);
  const battler = { id: 56, shown: false, isEnemy: () => true, enemyId() { return this.id; },
    hpGaugeVisible() { return this.shown; }, showATBGauge() { return this.shown; } };
  return { context, battler, windows: [new HP(), new ATB()] };
}

test('hidden hand gauges retain their windows and resume ordinary drawing when shown', () => {
  const f = fixture();
  for (const window of f.windows) {
    window._battler = f.battler; window.update(); window.update();
    assert.equal(window.visible, true); assert.equal(window.updates, 0);
  }
  f.battler.shown = true;
  for (const window of f.windows) {
    assert.equal(window.update(), 'ordinary'); assert.equal(window.visible, true);
    assert.equal(window._requestRefresh, true); assert.equal(window.updates, 1);
  }
});

test('suppression and resumption leave visibility owned by the game', () => {
  for (const visible of [false, true]) {
    const f = fixture();
    for (const window of f.windows) {
      window._battler = f.battler;
      window.update();
      window.visible = visible;
      window.update();
      assert.equal(window.visible, visible);
    }
    f.battler.shown = true;
    for (const window of f.windows) {
      window.update();
      assert.equal(window.visible, visible);
      assert.equal(window._requestRefresh, true);
    }
  }
});

test('visible fades, Bourdon body, missing battlers and other battles retain updates', () => {
  const f = fixture(), w = f.windows[0]; w._battler = f.battler;
  w.contentsOpacity = 32; w.update(); w.contentsOpacity = 0;
  f.battler.id = 24; w.update(); f.battler.id = 56;
  f.context.$gameTroop._troopId = 1; w.update(); w._battler = null; w.update();
  assert.equal(w.updates, 4); assert.equal(w.visible, true);
});
