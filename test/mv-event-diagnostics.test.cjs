'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

function fixture(plugin) {
  const clock = { time: 0 }, warnings = [];
  function Interpreter(list, event = 1) {
    this._list = list; this._index = 0; this._eventId = event; this._mapId = 2;
    this._frameCount = 0; this._freezeChecker = 0; this._childInterpreter = null;
  }
  Interpreter.prototype.checkFreeze = function() {
    if (this._frameCount !== graphics.frameCount) {
      this._frameCount = graphics.frameCount; this._freezeChecker = 0;
    }
    return this._freezeChecker++ >= 100000;
  };
  Interpreter.prototype.update = function(argument) {
    while (this._index < this._list.length) {
      if (this._childInterpreter) { this._childInterpreter.update(argument); this._childInterpreter = null; }
      this._list[this._index++].run.call(this);
      if (this.checkFreeze()) break;
    }
    return argument;
  };
  function Map() { this._mapId = 2; this.interpreters = []; }
  Map.prototype.update = function() { this.interpreters.forEach(interpreter => interpreter.update()); };
  const graphics = { frameCount: 1 };
  const guestChecker = Interpreter.prototype.checkFreeze;
  const ctx = loadPmjsRuntime({
    Game_Interpreter: Interpreter, Game_Map: Map, Graphics: graphics, $gameMap: { _mapId: 2 },
    $dataCommonEvents: [], performance: { now() { return clock.time; } },
    console: { warn(message) { warnings.push(message); } }
  }, ['js/pmjs-core/methods.js']);
  ctx.PMJS.compat = { audit: false }; ctx.PMJS.phases = { on() {} };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-mv/diagnostics.js'), 'utf8'), ctx);
  if (plugin) plugin(Interpreter);
  ctx.PMJS.methods.install();
  return { clock, warnings, Interpreter, Map, graphics, ctx, guestChecker };
}
function command(run, code = 355) { return { code, run }; }
function warning(f) { return JSON.parse(f.warnings[0].slice(f.warnings[0].indexOf('{'))); }

test('slow finite work completes under stock rules before the next observer', () => {
  const f = fixture(), seen = [];
  const list = Array.from({ length: 200 }, (_, index) => command(function() { f.clock.time += 1; seen.push(index); }));
  const i = new f.Interpreter(list);
  assert.equal(i.update('guest-result'), 'guest-result');
  assert.equal(i._index, 200);
  assert.deepEqual(seen, Array.from({ length: 200 }, (_, index) => index));
  assert.equal(f.Interpreter.prototype.checkFreeze, f.guestChecker);
  assert.equal(f.warnings.length, 1);
  assert.equal(warning(f).freezeChecks, 200);
  assert.equal(warning(f).elapsedMs, 200);
});

test('fast updates remain quiet and the original command cap stays active', () => {
  const f = fixture();
  const i = new f.Interpreter(Array.from({ length: 100002 }, () => command(function() {})));
  i.update();
  assert.equal(i._index, 100001);
  assert.equal(f.warnings.length, 0);
});

test('nested reporting identifies the slow child without double counting commands', () => {
  const f = fixture();
  const list = [command(function() { f.clock.time += 120; })];
  const child = new f.Interpreter(list, 0);
  f.ctx.$dataCommonEvents[7] = { list };
  const parent = new f.Interpreter([command(function() {}), command(function() {})]);
  parent._childInterpreter = child;
  parent.update();
  assert.equal(f.warnings.length, 1);
  const row = warning(f);
  assert.equal(row.common, 7); assert.equal(row.depth, 1); assert.equal(row.freezeChecks, 3);
});

test('repeat warnings are bounded, and changed event lists are reported', () => {
  const f = fixture(), i = new f.Interpreter([command(function() { f.clock.time += 120; })]);
  i.update(); i._index = 0; i.update();
  assert.equal(f.warnings.length, 1);
  f.clock.time += 5000; i._index = 0; i.update();
  assert.equal(f.warnings.length, 2);
  i._list = [command(function() { f.clock.time += 120; })]; i._index = 0; i.update();
  assert.equal(f.warnings.length, 3);
});

test('guest exceptions survive failing diagnostics and tracking unwinds', () => {
  const f = fixture(), error = new Error('guest exception');
  f.ctx.console.warn = function() { throw new Error('logger exception'); };
  const bad = new f.Interpreter([command(function() { f.clock.time += 150; throw error; })]);
  assert.throws(() => bad.update(), caught => caught === error);
  const good = new f.Interpreter([command(function() {})]);
  assert.equal(good.update('recovered'), 'recovered');
});

test('diagnostics wrap the final plugin update once and preserve its result', () => {
  let calls = 0;
  const f = fixture(Interpreter => {
    const update = Interpreter.prototype.update;
    Interpreter.prototype.update = function(argument) {
      calls++; update.call(this, argument); return 'plugin-result';
    };
  });
  assert.equal(f.ctx.PMJS.methods.dump().find(record => record.key === 'Game_Interpreter.update').id, 'pmjs.mv.event-stall-diagnostics');
  const i = new f.Interpreter([command(function() {})]);
  assert.equal(i.update('argument'), 'plugin-result');
  assert.equal(i._index, 1);
  assert.equal(calls, 1);
});

 test('map updates aggregate short interpreters and parallel events without changing their order', () => {
  const f = fixture(), map = new f.Map(), order = [];
  map.interpreters = [1, 2, 3].map(id => new f.Interpreter([command(function() {
    order.push(id); f.clock.time += 40;
  })], id));
  map.update();
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(f.warnings.length, 1);
  assert.equal(warning(f).elapsedMs, 120); assert.equal(warning(f).freezeChecks, 3);
});
