'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/battle-selection-refresh.js'), 'utf8');
function fixture(recognized = true) {
  function Selection() { this._battler = {}; this._showEnemyName = false; this._requestRefresh = true; this.clears = 0; this.paints = 0; }
  Selection.prototype.refresh = function() { this.clears++; if (!this._battler || !this._showEnemyName) return; this._requestRefresh = false; this.paints++; };
  Selection.prototype.update = function() { if (this._requestRefresh) this.refresh(); };
  const original = Selection.prototype.refresh;
  const context = { Window_EnemyVisualSelect: Selection, $gameTroop: { _troopId: 5 }, PMJS: {
    isatSourceQualification: { verified: true }, isatMethodHash: () => recognized ? 'cc796b00a881745f0dec5998e9086949e9ba8491203477c5691c5ed8bf72e720' : 'foreign',
    phases: { on(phase, name, callback) { callback(); } }
  } };
  vm.runInNewContext(source, context);
  return {context, Selection, original};
}
test('ordinary monsters clear hidden names once and repaint when names become visible', () => {
  const f = fixture(), w = new f.Selection();
  w.update(); w.update(); assert.equal(w.clears, 1); assert.equal(w._requestRefresh, false);
  w._requestRefresh = true; w.update(); assert.equal(w.clears, 2);
  w._showEnemyName = true; w.update(); assert.equal(w.paints, 1); assert.equal(w.clears, 3);
  w.update(); assert.equal(w.clears, 3);
});
test('missing battlers, changed qualification and unrecognized producers retain ordinary refresh', () => {
  const f = fixture(), w = new f.Selection();
  w._battler = null; w.update(); w.update(); assert.equal(w.clears, 2); assert.equal(w._requestRefresh, true);
  w._battler = {}; f.context.PMJS.isatSourceQualification = {verified:true}; w.update(); assert.equal(w._requestRefresh, true);
  const foreign = fixture(false); assert.equal(foreign.Selection.prototype.refresh, foreign.original);
});
