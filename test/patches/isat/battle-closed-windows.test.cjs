'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/battle-closed-windows.js'), 'utf8');

function fixture() {
  let ordinary = 0, inactive = true;
  function Base() {}
  Base.prototype.update = function() {
    this.baseUpdates++;
    for (const child of this.children) if (child.update) child.update();
  };
  function Window() {
    this.visible = true; this.openness = 0; this.active = false;
    this._stayCount = 0; this.baseUpdates = 0; this.children = []; this.inputs = 0;
  }
  Window.prototype = Object.create(Base.prototype);
  Window.prototype.updateArrows = function() { this.arrowsUpdated = true; };
  for (const name of ['processCursorMove', 'processHandling', 'processWheel', 'processTouch']) {
    Window.prototype[name] = function() { this.inputs++; };
  }
  Window.prototype.update = function() {
    ordinary++; Base.prototype.update.call(this); this._stayCount++; return 'ordinary';
  };
  const original = Window.prototype.update;
  const context = { Window_Base: Base, Window_Selectable: Window, $gameTroop: { _troopId: 26 }, PMJS: {
    isatSourceQualification: { verified: true }, isatHorrorPresentation: { isInactive: () => inactive },
    phases: { on(phase, name, callback) { callback(); } } } };
  vm.runInNewContext(source, context);
  return { context, Window, original, get ordinary() { return ordinary; }, set inactive(value) { inactive = value; } };
}

test('closed windows keep child updates and counters while omitting inactive input handling', () => {
  const f = fixture(), w = new f.Window();
  let childUpdates = 0;
  w.children.push({ update() { childUpdates++; } });
  w._touching = true;
  w.update();
  assert.equal(f.ordinary, 0);
  assert.equal(w.baseUpdates, 1);
  assert.equal(childUpdates, 1);
  assert.equal(w._stayCount, 1);
  assert.equal(w._touching, false);
  assert.equal(w.arrowsUpdated, true);
  assert.equal(w.inputs, 0);
  for (const key of ['_opening', '_closing', 'active']) {
    w[key] = true; assert.equal(w.update(), 'ordinary'); w[key] = false;
  }
  w.openness = 255; w.update(); w.visible = false; w.update(); assert.equal(f.ordinary, 4);
  f.inactive = false; w.update(); assert.equal(f.ordinary, 5);
  f.inactive = true; f.context.$gameTroop._troopId = 1; w.update(); assert.equal(f.ordinary, 6);
  assert.equal(w.baseUpdates, 8);
  assert.equal(childUpdates, 8);
  assert.equal(w._stayCount, 8);
});

test('a plugin child activating the window still receives input processing in the same update', () => {
  const f = fixture(), w = new f.Window();
  w.children.push({ update() { w.active = true; w.openness = 255; } });
  w.update();
  assert.equal(w.baseUpdates, 1);
  assert.equal(w.inputs, 4);
  assert.equal(w._stayCount, 1);
});
