'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');
const source = fs.readFileSync(require.resolve('../js/pmjs-plugins/dreamx/damage-popup-retirement.js'), 'utf8');
const id = 'plugins.dreamx.damage-popup-retirement';

function legacyUpdate() {
  this.setupDamagePopup();
  for (const popup of this._damages) popup.update();
  if (this._damages.length && !this._damages[0].isPlaying()) {
    this.parent.removeChild(this._damages[0]);
    this._damages.shift();
  }
}
function reparentPopups() {}
function fixture({ disabled = false, unknown = false, unknownProducer = false, missingVE = false } = {}) {
  const ctx = loadPmjsRuntime({ __pmjsBuiltinRequire: require, console: { log() {}, error() {}, warn() {} },
    PMJS_GAME_CONFIG: { disableOptimizations: disabled ? [id] : [] } });
  ctx.Sprite_Battler = function() {};
  Object.assign(ctx.Sprite_Battler.prototype, { updateDamagePopup: legacyUpdate, damagePopupSprite: reparentPopups });
  const hash = fn => crypto.createHash('sha256').update(fn.toString()).digest('hex');
  if (unknown) ctx.Sprite_Battler.prototype.updateDamagePopup = function changed() {};
  if (unknownProducer) ctx.Sprite_Battler.prototype.damagePopupSprite = function changedProducer() {};
  vm.runInContext(source.replace('190a974ff58f3028f03bdef044abe9d14ebdc9ed3c511e4d15b92cb44c308ac2', hash(legacyUpdate))
    .replace('7ece5d64382a9a48a1f25323024af59f9e36f3286a6fca73cfb5e3d4a2d0238d', hash(reparentPopups)), ctx);
  if (!missingVE) ctx.PMJS.plugins.execute('VE_DamagePopup', () => {});
  ctx.PMJS.plugins.execute('DreamX_Ext_VE_DamagePopup', () => {});
  ctx.PMJS.phases.emit('afterGuestPlugins');
  const field = container(), scene = container(), battler = new ctx.Sprite_Battler();
  Object.assign(battler, { parent: field, _damages: [], setupDamagePopup() {} });
  return { ctx, battler, field, scene };
}
function container() {
  return { children: [], addChild(child) {
    if (child.parent) child.parent.removeChild(child);
    this.children.push(child); child.parent = this;
  }, removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) { this.children.splice(index, 1); child.parent = null; }
  } };
}
function popup(ticks = 1) {
  return { ticks, updates: 0, bitmap: { retained: true },
    update() { this.updates++; this.ticks--; }, isPlaying() { return this.ticks > 0; },
    destroy() { assert.fail('detachment must preserve retained popup resources'); } };
}

test('finished popups leave their actual parent, queue and retained resources remain usable', () => {
  const f = fixture(), p = popup(), bitmap = p.bitmap;
  f.battler._damages.push(p); f.scene.addChild(p);
  f.battler.updateDamagePopup();
  assert.equal(f.battler._damages.length, 0);
  assert.equal(f.scene.children.length, 0);
  assert.equal(p.parent, null); assert.equal(p.updates, 1); assert.equal(p.bitmap, bitmap);
  f.field.addChild(p); assert.equal(p.parent, f.field);
});

test('active popups keep their authored updates and queue order; only one head retires per call', () => {
  const f = fixture(), first = popup(2), next = popup(1);
  f.battler._damages.push(first, next); f.scene.addChild(first); f.scene.addChild(next);
  f.battler.updateDamagePopup();
  assert.deepEqual(f.battler._damages, [first, next]); assert.equal(next.updates, 1);
  f.battler.updateDamagePopup();
  assert.deepEqual(f.battler._damages, [next]); assert.equal(next.parent, f.scene);
  f.battler.updateDamagePopup(); assert.equal(next.parent, null);
});

test('setup-created immediate popups, detached popups and transferred popups retire safely', () => {
  for (const parent of ['scene', 'field', 'other', 'detached']) {
    const f = fixture(), p = popup(), owner = parent === 'other' ? container() : f[parent];
    if (owner) owner.addChild(p);
    f.battler.setupDamagePopup = function() { this._damages.push(p); };
    f.battler.updateDamagePopup();
    assert.equal(p.parent || null, null); assert.equal(f.battler._damages.length, 0);
  }
});

test('popup update failures preserve ownership and queue membership', () => {
  const f = fixture(), p = popup(); p.update = () => { throw new Error('update failure'); };
  f.battler._damages.push(p); f.scene.addChild(p);
  assert.throws(() => f.battler.updateDamagePopup(), /update failure/);
  assert.equal(p.parent, f.scene); assert.deepEqual(f.battler._damages, [p]);
});

test('disabled and unrecognized compositions preserve the ordinary guest method', () => {
  const disabled = fixture({ disabled: true }), p = popup();
  disabled.battler._damages.push(p); disabled.scene.addChild(p); disabled.battler.updateDamagePopup();
  assert.equal(p.parent, disabled.scene); assert.equal(disabled.battler.updateDamagePopup, legacyUpdate);
  for (const options of [{ unknown: true }, { unknownProducer: true }, { missingVE: true }]) {
    const f = fixture(options);
    assert.match(f.ctx.PMJS.optimizations.reason(id), /unrecognized popup/);
  }
});
