'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

const id = 'plugins.yanfly.enemy-atb-refresh';
const source = fs.readFileSync(require.resolve('../js/pmjs-plugins/yanfly/visual-atb-gauge.js'), 'utf8');

// Independent faulty guest fixture; the adapter must replace this method.
function brokenCheck() {
  if (!this._battler) return;
  this._currentATBSpeed = this._battler.atbCharge();
  this._requestRefresh = true;
}

function fixture({ disabled = false, composed = false } = {}) {
  const ctx = loadPmjsRuntime({
    __pmjsBuiltinRequire: require,
    console: { log() {}, error() {} },
    PMJS_GAME_CONFIG: { disableOptimizations: disabled ? [id] : [] },
  });
  ctx.Window_EnemyVisualATB = function() {};
  ctx.Window_EnemyVisualATB.prototype.updateATBPosition = composed
    ? function customCheck() { this.customChecks = (this.customChecks || 0) + 1; }
    : brokenCheck;
  const original = ctx.Window_EnemyVisualATB.prototype.updateATBPosition;
  const digest = crypto.createHash('sha256').update(brokenCheck.toString()).digest('hex');
  vm.runInContext(source.replace(/58c487e44dfefa99c48880d7e7c1e6984e1f020c09cad4d226f4b7031a21005b/g,
    digest), ctx);
  ctx.PMJS.plugins.execute('YEP_X_VisualATBGauge', () => {});
  ctx.PMJS.phases.emit('afterGuestPlugins');
  function gauge() {
    const window = new ctx.Window_EnemyVisualATB();
    const battler = { speed: 15000, charge: 0,
      atbSpeed() { return this.speed; }, atbCharge() { return this.charge; } };
    Object.assign(window, { _battler: battler, _currentATBSpeed: 0,
      _currentATBCharge: 0, _requestRefresh: false, refreshes: 0 });
    function tick() {
      window.updateATBPosition();
      if (window._requestRefresh) { window.refreshes++; window._requestRefresh = false; }
    }
    return { window, battler, tick };
  }
  return { ctx, original, gauge };
}

test('seven unchanged enemy gauges redraw once across repeated battle updates', () => {
  const f = fixture();
  const gauges = Array.from({ length: 7 }, () => f.gauge());
  for (let i = 0; i < 240; i++) for (const g of gauges) g.tick();
  assert.equal(gauges.reduce((sum, g) => sum + g.window.refreshes, 0), 7);
});

test('speed, charge-only, and charge-reset transitions each request one redraw', () => {
  const { window, battler, tick } = fixture().gauge();
  tick();
  for (const [speed, charge] of [[16000, 0], [16000, 200], [16000, 400], [0, 0]]) {
    const previous = window.refreshes;
    Object.assign(battler, { speed, charge });
    tick();
    tick();
    assert.equal(window.refreshes, previous + 1);
    assert.equal(window._currentATBSpeed, speed);
    assert.equal(window._currentATBCharge, charge);
  }
});

test('preserves an existing refresh request and handles a missing battler', () => {
  const { window, tick } = fixture().gauge();
  tick();
  window._requestRefresh = true;
  tick();
  assert.equal(window.refreshes, 2);
  window._battler = null;
  tick();
  assert.equal(window.refreshes, 2);
});

test('preserves custom method compositions and reports refusal', () => {
  const { ctx, original, gauge } = fixture({ composed: true });
  const g = gauge();
  g.tick();
  assert.equal(ctx.Window_EnemyVisualATB.prototype.updateATBPosition, original);
  assert.equal(g.window.customChecks, 1);
  assert.match(ctx.PMJS.optimizations.reason(id), /unrecognized enemy ATB/);
});

test('disabled adapter leaves the faulty guest method unchanged', () => {
  const { ctx, original, gauge } = fixture({ disabled: true });
  const g = gauge();
  g.tick();
  g.tick();
  assert.equal(g.window.refreshes, 2);
  assert.equal(ctx.Window_EnemyVisualATB.prototype.updateATBPosition, original);
});
