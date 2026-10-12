'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPmjsRuntime } = require('./helpers/runtime-context.cjs');

function fixture(budgetMs, plugin) {
  const clock = { time: 0, reads: 0 };
  const graphics = { frameCount: 7 };
  function Interpreter(commands, options = {}) {
    this.commands = commands;
    this._index = 0;
    this._waitCount = 0;
    this._freezeChecker = 0;
    this._frameCount = -1;
    this._childInterpreter = null;
    this.cost = options.cost ?? 0.1;
    this.repeat = !!options.repeat;
    this.executed = 0;
  }
  Interpreter.prototype.isRunning = function() {
    return this._index < this.commands.length;
  };
  Interpreter.prototype.updateChild = function() {
    if (this._childInterpreter) {
      this._childInterpreter.update();
      if (this._childInterpreter.isRunning()) return true;
      this._childInterpreter = null;
    }
    return false;
  };
  Interpreter.prototype.updateWait = function() {
    if (this._waitCount > 0) {
      this._waitCount--;
      return true;
    }
    return false;
  };
  Interpreter.prototype.executeCommand = function() {
    const command = this.commands[this._index];
    clock.time += this.cost;
    this.executed++;
    command.call(this);
    this._index++;
    if (this.repeat && this._index === this.commands.length) this._index = 0;
    return true;
  };
  // MV calls the freeze checker after dispatch, and the parent waits for its child.
  Interpreter.prototype.update = function() {
    while (this.isRunning()) {
      if (this.updateChild() || this.updateWait()) break;
      if (!this.executeCommand()) break;
      if (this.checkFreeze()) break;
    }
  };
  Interpreter.prototype.checkFreeze = function() {
    if (this._frameCount !== graphics.frameCount) {
      this._frameCount = graphics.frameCount;
      this._freezeChecker = 0;
    }
    return this._freezeChecker++ >= 100000;
  };
  const config = budgetMs === undefined ? {} : { interpreterBudgetMs: budgetMs };
  const ctx = loadPmjsRuntime({
    PMJS_GAME_CONFIG: config, Game_Interpreter: Interpreter, Graphics: graphics,
    performance: { now() { clock.reads++; return clock.time; } },
  }, ['js/pmjs-core/config.js', 'js/pmjs-core/methods.js']);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../js/pmjs-mv/interpreter.js'), 'utf8'), ctx);
  const guest = { update: Interpreter.prototype.update, check: Interpreter.prototype.checkFreeze };
  if (plugin) plugin(Interpreter, clock);
  ctx.PMJS.methods.install();
  return { ctx, Interpreter, clock, graphics, guest };
}

const idle = function() {};

for (const value of [undefined, 0]) {
  test('disabled budget ' + value + ' leaves the guest methods and clock untouched', () => {
    const f = fixture(value);
    assert.equal(f.Interpreter.prototype.update, f.guest.update);
    assert.equal(f.Interpreter.prototype.checkFreeze, f.guest.check);
    const interpreter = new f.Interpreter([idle], { repeat: true });
    interpreter.update();
    assert.equal(interpreter.executed, 100001);
    assert.equal(f.clock.reads, 0);
    assert.equal(f.ctx.PMJS.methods.dump().length, 0);
  });
}

test('invalid configured budgets fail instead of silently disabling the safeguard', () => {
  for (const value of [-1, NaN, Infinity, '4', null, true]) {
    assert.throws(() => fixture(value), /interpreterBudgetMs/);
  }
});

for (const budget of [4, 12]) {
  test(budget + ' ms yields a busy interpreter at sampled command boundaries', () => {
    const f = fixture(budget);
    const interpreter = new f.Interpreter([idle], { repeat: true });
    interpreter.update();
    assert.ok(f.clock.time >= budget);
    assert.ok(f.clock.time < budget + 64 * interpreter.cost);
    assert.equal(interpreter.executed % 64, 0);
    assert.equal(interpreter._freezeChecker, interpreter.executed);
    assert.equal(f.clock.reads, 1 + interpreter.executed / 64);
  });
}

test('nested interpreters inherit the outer deadline and check count', () => {
  const f = fixture(4);
  const child = new f.Interpreter([idle], { repeat: true, cost: 0.02 });
  const parent = new f.Interpreter([function() { this._childInterpreter = child; }, idle], { cost: 3 });
  parent.update();
  assert.equal(parent.executed, 1);
  assert.equal(child.executed, 63);
  assert.equal(parent._childInterpreter, child);
  assert.equal(f.clock.reads, 2);
  assert.equal(parent._index, 1);
});

test('independent parallel updates receive fresh deadlines', () => {
  const f = fixture(4);
  const first = new f.Interpreter([idle], { repeat: true });
  const second = new f.Interpreter([idle], { repeat: true });
  first.update();
  second.update();
  assert.equal(first.executed, 64);
  assert.equal(second.executed, 64);
  assert.equal(f.clock.reads, 4);
});

test('consecutive logic updates sharing one presentation reset only the time budget', () => {
  const f = fixture(4);
  const interpreter = new f.Interpreter([idle], { repeat: true });
  interpreter.update();
  f.clock.time += 100;
  interpreter.update();
  assert.equal(f.graphics.frameCount, 7);
  assert.equal(interpreter.executed, 128);
  assert.equal(interpreter._freezeChecker, 128, 'the guest counter is not reset');
  assert.equal(f.clock.reads, 4);
});

test('long finite event work resumes at its next command without replay or omission', () => {
  const f = fixture(4);
  const observed = [];
  const interpreter = new f.Interpreter(Array.from({ length: 200 }, (_, index) =>
    function() { observed.push(index); }));
  interpreter.update();
  assert.equal(interpreter._index, 64);
  interpreter.update();
  assert.equal(interpreter._index, 128);
  interpreter.update();
  assert.equal(interpreter._index, 192);
  interpreter.update();
  assert.equal(interpreter.isRunning(), false);
  assert.deepEqual(observed, Array.from({ length: 200 }, (_, index) => index));
});

test('ordinary waits and fresh input on the next update retain their behavior', () => {
  const f = fixture(4);
  let pressed = false;
  const actions = [];
  const interpreter = new f.Interpreter([
    function() { if (pressed) actions.push('input'); this._waitCount = 1; },
    function() { if (pressed) actions.push('fresh'); },
  ]);
  interpreter.update();
  assert.equal(interpreter._index, 1);
  assert.equal(interpreter._waitCount, 0);
  pressed = true;
  interpreter.update();
  assert.deepEqual(actions, ['fresh']);
  assert.equal(interpreter.isRunning(), false);
});

test('the final plugin checker runs first and retains its return and receiver', () => {
  const seen = [];
  const f = fixture(4, Interpreter => {
    Interpreter.prototype.checkFreeze = function() {
      seen.push(this);
      return 'plugin-yield';
    };
    const update = Interpreter.prototype.update;
    Interpreter.prototype.update = function(argument) {
      assert.equal(argument, 'plugin-argument');
      update.call(this);
      return 'plugin-result';
    };
  });
  const interpreter = new f.Interpreter([idle], { repeat: true });
  assert.equal(interpreter.update('plugin-argument'), 'plugin-result');
  assert.equal(interpreter.executed, 1);
  assert.equal(seen[0], interpreter);
  assert.equal(f.clock.reads, 1);
  assert.equal(interpreter.checkFreeze(), 'plugin-yield');
});

test('the stock command-count cap remains active even when the clock has not advanced', () => {
  const f = fixture(4);
  const interpreter = new f.Interpreter([idle], { repeat: true, cost: 0 });
  interpreter.update();
  assert.equal(interpreter.executed, 100001);
  assert.equal(interpreter._freezeChecker, 100001);
});

test('checks outside an interpreter update use only the guest checker', () => {
  const f = fixture(4);
  const interpreter = new f.Interpreter([idle]);
  for (let i = 0; i < 200; i++) assert.equal(interpreter.checkFreeze(), false);
  assert.equal(f.clock.reads, 0);
  assert.equal(interpreter._freezeChecker, 200);
});

test('nested command exceptions unwind the budget before another independent update', () => {
  const f = fixture(4);
  const error = new Error('guest command');
  const child = new f.Interpreter([function() { throw error; }]);
  const parent = new f.Interpreter([function() { this._childInterpreter = child; }, idle]);
  assert.throws(() => parent.update(), caught => caught === error);
  f.clock.time += 100;
  const next = new f.Interpreter([idle], { repeat: true });
  next.update();
  assert.equal(next.executed, 64);
});

test('one expensive script is never interrupted between command boundaries', () => {
  const f = fixture(4);
  let completed = false;
  const interpreter = new f.Interpreter([function() {
    f.clock.time += 100;
    completed = true;
  }]);
  interpreter.update();
  assert.equal(completed, true);
  assert.equal(interpreter.isRunning(), false);
  assert.ok(f.clock.time > 4);
});
