'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../../patches/isat/intro-picture-handoff.js'), 'utf8');

function fixture({ enabled = true, qualified = true } = {}) {
  const pictures = new Map([[8, 'last-intro-picture']]);
  const nextBitmap = { ready: false, isReady() { return this.ready; } };
  let tone = -255;
  const list = Array.from({ length: 76 }, () => ({ code: 0, parameters: [] }));
  for (const [index, code, parameters] of [
    [67, 231, [8, 'event_act1_0intro5d', 0, 0, 0, 0, 100, 100, 255, 0]],
    [68, 230, [6]],
    [69, 235, [7]],
    [70, 235, [8]],
    [71, 241, [{ name: '', volume: 90, pitch: 100, pan: 0 }]],
    [72, 108, ['\\\\\\intro']],
    [73, 223, [[0, 0, 0, 0], 1, false]],
    [74, 245, [{ name: '000_sounds_birds', volume: 100, pitch: 100, pan: 0 }]],
    [75, 231, [9, 'event_act1_1intro1', 0, 0, 0, 0, 100, 100, 255, 0]]
  ]) list[index] = { code, indent: 0, parameters };

  function Interpreter() {
    this._mapId = 2;
    this._eventId = 7;
    this._list = list;
    this._index = 70;
  }
  Interpreter.prototype.executeCommand = function() {
    const command = this._list[this._index];
    if (!command) return false;
    this._params = command.parameters;
    const method = this['command' + command.code];
    if (method && method.call(this) === false) return false;
    this._index++;
    return true;
  };
  Interpreter.prototype.update = function() {
    while (this._index < this._list.length && this.executeCommand()) {}
  };
  Interpreter.prototype.command235 = function() {
    pictures.delete(this._params[0]);
    return true;
  };
  Interpreter.prototype.command223 = function() {
    tone = this._params[0][0];
    return true;
  };
  Interpreter.prototype.command231 = function() {
    pictures.set(this._params[0], this._params[1]);
    return true;
  };

  const context = vm.createContext({
    Game_Interpreter: Interpreter,
    ImageManager: { loadPicture(name) {
      assert.equal(name, 'event_act1_1intro1');
      return nextBitmap;
    } },
    PMJS: { isatSourceQualification: { verified: qualified },
      phases: { on(phase, id, callback) { callback(); } } }
  });
  if (enabled) vm.runInContext(source, context);

  function presentedFrame() {
    for (const [id, name] of [...pictures].reverse()) {
      if (id !== 9 || nextBitmap.ready) return name;
    }
    return tone === -255 ? 'black' : 'map';
  }

  return { interpreter: new Interpreter(), presentedFrame, nextBitmap, list, pictures, context };
}

test('Map002 intro keeps its previous cover and command position until the next picture is ready', () => {
  const { interpreter, presentedFrame, nextBitmap, pictures } = fixture();
  assert.equal(presentedFrame(), 'last-intro-picture');
  interpreter.update();
  assert.equal(presentedFrame(), 'last-intro-picture', 'loading must not expose the map');
  assert.equal(interpreter._index, 70);
  assert.equal(pictures.has(9), false);
  nextBitmap.ready = true;
  interpreter.update();
  assert.equal(presentedFrame(), 'event_act1_1intro1');
  assert.equal(pictures.has(8), false);
  assert.equal(interpreter._index, 76);
});

test('authored unguarded timing exposes the map when the replacement is not ready', () => {
  const f = fixture({ enabled: false });
  f.interpreter.update();
  assert.equal(f.presentedFrame(), 'map');
});

test('already-ready and failed pictures preserve ordinary command progression', () => {
  for (const ready of [true, false]) {
    const f = fixture();
    f.nextBitmap.ready = ready;
    f.nextBitmap.isError = () => !ready;
    f.interpreter.update();
    assert.equal(f.interpreter._index, 76);
    assert.equal(f.pictures.has(8), false);
  }
});

test('changed event sequences, other owners and unknown sources keep ordinary erasure', () => {
  for (const mutate of [
    f => { f.interpreter._mapId = 3; }, f => { f.interpreter._eventId = 8; },
    f => { f.list[75].parameters[1] = 'different-picture'; },
    f => { f.list[73].parameters[0][0] = -255; },
    f => { f.context.PMJS.isatSourceQualification = { verified: true }; }
  ]) {
    const f = fixture(); mutate(f); f.interpreter.update();
    assert.equal(f.interpreter._index, 76);
  }
  const f = fixture({ qualified: false }); f.interpreter.update();
  assert.equal(f.presentedFrame(), 'map');
});

test('a copied saved list is not rewritten or reset during the handoff', () => {
  const f = fixture();
  f.interpreter._list = JSON.parse(JSON.stringify(f.list));
  const before = JSON.stringify(f.interpreter._list);
  const branch = f.interpreter._branch = { 0: true };
  const child = f.interpreter._childInterpreter = { pending: true };
  f.interpreter._waitCount = 0;
  f.interpreter.update();
  assert.equal(f.interpreter._index, 70);
  assert.equal(f.interpreter._branch, branch);
  assert.equal(f.interpreter._childInterpreter, child);
  assert.equal(f.interpreter._waitCount, 0);
  assert.equal(JSON.stringify(f.interpreter._list), before);
  f.nextBitmap.ready = true; f.interpreter.update();
  assert.equal(f.presentedFrame(), 'event_act1_1intro1');
});
