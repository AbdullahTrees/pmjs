'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup(observe = true) {
  let install;
  let consumed = 0;
  const tasks = [];
  const context = {
    NativeHost: {
      input: { consumePressed() { consumed++; } },
      runtime: { env: () => '', now: () => 0,
        platform: () => ({ platform: 'linux', arch: 'x64' }),
        displaySize: () => ({ width: 640, height: 480 }),
        windowSize: () => ({ width: 640, height: 480 }) }
    },
    PMJS: { phases: { on(_name, _owner, callback) { install = callback; } },
      tasks: { enqueue(callback) { tasks.push(callback); } } }
  };
  context.globalThis = context;
  context.Input = {
    keyMapper: { 65: 'tag', 67: 'ok', 90: 'ok', 37: 'left' },
    gamepadMapper: { 3: 'tag', 12: 'up', 14: 'left' },
    clear() { this._currentState = {}; this._previousState = {}; this._gamepadStates = []; this._latestButton = null; this._pressedTime = 0; },
    _onKeyDown(event) { const action = this.keyMapper[event.keyCode]; if (action) this._currentState[action] = true; },
    _onKeyUp(event) { const action = this.keyMapper[event.keyCode]; if (action) this._currentState[action] = false; },
    _updateGamepadState(pad) {
      const previous = this._gamepadStates[pad.index] || [];
      const next = pad.buttons.map(button => button.pressed);
      next[12] ||= pad.axes[1] < -0.5;
      next[13] ||= pad.axes[1] > 0.5;
      next[14] ||= pad.axes[0] < -0.5;
      next[15] ||= pad.axes[0] > 0.5;
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== previous[i] && this.gamepadMapper[i]) this._currentState[this.gamepadMapper[i]] = next[i];
      }
      this._gamepadStates[pad.index] = next;
    },
    _pollGamepads() {
      for (const pad of context.navigator.getGamepads()) if (pad?.connected) this._updateGamepadState(pad);
    },
    update() {
      this._pollGamepads();
      if (this._currentState[this._latestButton]) this._pressedTime++;
      else this._latestButton = null;
      for (const action in this._currentState) {
        if (this._currentState[action] && !this._previousState[action]) {
          this._latestButton = action; this._pressedTime = 0;
        }
        this._previousState[action] = this._currentState[action];
      }
    },
    isPressed(action) { return !!this._currentState[action]; },
    isTriggered(action) { return this._latestButton === action && this._pressedTime === 0; }
  };
  context.Input.clear();
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/runtime.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/events.js'), 'utf8'), context);
  context.CanvasContext2D = function() {};
  vm.runInContext(require('./helpers/web-element-sources.cjs').source, context);
  context.document.addEventListener('keydown', event => context.Input._onKeyDown(event));
  context.document.addEventListener('keyup', event => context.Input._onKeyUp(event));
  context.addEventListener('blur', () => context.Input.clear());
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-rpgmaker/input.js'), 'utf8'), context);
  install();
  function flushTasks() { while (tasks.length) tasks.shift()(); }
  context.sendInput = state => { context.__pmjsReceiveInput(state); flushTasks(); };
  if (observe) {
    context.navigator.getGamepads();
    context.sendInput(snapshot([], [], [], [pad()]));
  }
  return { context, consumed: () => consumed, flushTasks };
}

function key(code, down, repeat = false) {
  return { keyCode: code, code: 'Key' + String.fromCharCode(code), key: String.fromCharCode(code), down, repeat };
}
function snapshot(keysDown = [], keysPressed = [], keyEvents = [], gamepads = []) {
  return { keysDown, keysPressed, keyEvents, gamepads };
}
function pad(buttonsDown = [], buttonsPressed = [], axes = [0, 0, 0, 0]) {
  return { index: 0, instance: 7, id: 'Xbox Controller', buttonsDown, buttonsPressed, axes };
}

test('keyboard events use live mapper and preserve a short tap for one logic step', () => {
  const { context: ctx, consumed } = setup();
  ctx.sendInput(snapshot([], [65], [key(65, true), key(65, false)]));
  assert.equal(ctx.Input.isPressed('tag'), true);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), true);
  assert.equal(ctx.Input.isPressed('tag'), false);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), false);
  assert.equal(consumed(), 2);
  ctx.Input.keyMapper[65] = undefined;
  ctx.Input.keyMapper[67] = 'tag';
  ctx.sendInput(snapshot([67], [67], [key(67, true)]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('tag'), true);
  assert.equal(ctx.Input.isTriggered('tag'), true);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), false);
});

test('gamepad shape, mapper, axes, and disconnect follow stock polling', () => {
  const { context: ctx } = setup();
  assert.deepEqual(Array.from(ctx.navigator.getGamepads()), []);
  ctx.sendInput(snapshot([], [], [], [pad([3], [3])]));
  const first = ctx.navigator.getGamepads()[0];
  assert.equal(first.id, 'Xbox Controller');
  assert.equal(first.mapping, 'standard');
  assert.equal(first.buttons[3].pressed, true);
  const pressedDescriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(first.buttons[3]), 'pressed');
  assert.equal(typeof pressedDescriptor.get, 'function');
  Object.defineProperty(first.buttons[3], 'pressed', pressedDescriptor);
  assert.equal(first.buttons[3].pressed, true);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), true);
  ctx.Input.gamepadMapper[3] = 'ok';
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('tag'), false);
  assert.equal(ctx.Input.isPressed('ok'), true);
  ctx.sendInput(snapshot([], [], [], [pad([3], [], [-1, 0, 0, 0])]));
  assert.equal(ctx.navigator.getGamepads()[0], first);
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('left'), true);
  ctx.sendInput(snapshot());
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), false);
  assert.equal(ctx.Input.isPressed('left'), false);
});

test('gamepads stay hidden until focused interaction and preserve the exposing state', () => {
  const { context: ctx } = setup();
  ctx.sendInput(snapshot([], [], [], [pad()]));
  assert.deepEqual(Array.from(ctx.navigator.getGamepads()), []);

  ctx.__pmjsUpdateWindowState({ focused: false, visible: true });
  ctx.sendInput(snapshot([], [], [], [pad([3], [3])]));
  assert.deepEqual(Array.from(ctx.navigator.getGamepads()), []);

  ctx.__pmjsUpdateWindowState({ focused: true, visible: true });
  ctx.sendInput(snapshot([], [], [], [pad([], [], [0, -0.6, 0, 0])]));
  const [first] = ctx.navigator.getGamepads();
  assert.equal(first.axes[1], -0.6);
  assert.equal(first.buttons[3].pressed, false);

  ctx.sendInput(snapshot([], [], [], [pad()]));
  assert.equal(ctx.navigator.getGamepads()[0], first);
  assert.equal(first.connected, true);
});

test('focus loss clears held keyboard state', () => {
  const { context: ctx } = setup();
  ctx.sendInput(snapshot([37], [37], [key(37, true)]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('left'), true);
  ctx.__pmjsUpdateWindowState({ focused: false, visible: true });
  assert.equal(ctx.Input.isPressed('left'), false);
});

test('gamepad tap between logic steps triggers once', () => {
  const { context: ctx, consumed } = setup();
  ctx.sendInput(snapshot([], [], [], [pad([], [3])]));
  assert.equal(ctx.navigator.getGamepads()[0].buttons[3].pressed, true);
  assert.equal(consumed(), 0);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), true);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), false);
  assert.equal(ctx.Input.isPressed('tag'), false);
});

test('disconnect keeps another controller at its browser index', () => {
  const { context: ctx } = setup();
  const second = { ...pad([3]), index: 1, instance: 8, id: 'Second Controller' };
  ctx.sendInput(snapshot([], [], [], [pad(), { ...second, buttonsDown: [] }]));
  ctx.sendInput(snapshot([], [], [], [pad(), second]));
  const stable = ctx.navigator.getGamepads()[1];
  ctx.sendInput(snapshot([], [], [], [
    { index: 0, instance: -1, connected: false, id: '', buttonsDown: [], buttonsPressed: [], axes: [] },
    second
  ]));
  assert.equal(ctx.navigator.getGamepads()[0], null);
  assert.equal(ctx.navigator.getGamepads()[1], stable);
  assert.equal(stable.index, 1);
});

test('one keyboard event dispatch reaches the shared document and window target once', () => {
  const { context: ctx } = setup();
  let delivered = 0;
  ctx.addEventListener('keydown', () => { delivered++; });
  ctx.sendInput(snapshot([65], [65], [key(65, true)]));
  assert.equal(delivered, 1);
});

test('remapping one of two held keys preserves their shared old action', () => {
  const { context: ctx } = setup();
  ctx.Input.keyMapper[13] = 'ok';
  ctx.sendInput(snapshot([13, 90], [13, 90], [key(13, true), key(90, true)]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  ctx.Input.keyMapper[90] = 'tag';
  ctx.sendInput(snapshot([13, 90]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  assert.equal(ctx.Input.isPressed('tag'), true);
});

test('gamepad remap preserves an action held by the keyboard', () => {
  const { context: ctx } = setup();
  ctx.Input.gamepadMapper[3] = 'ok';
  ctx.sendInput(snapshot([67], [67], [key(67, true)], [pad([3], [3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);

  ctx.Input.gamepadMapper[3] = 'tag';
  ctx.sendInput(snapshot([67], [], [], [pad([3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  assert.equal(ctx.Input.isPressed('tag'), true);
});

test('gamepad remap preserves an action held by another gamepad button', () => {
  const { context: ctx } = setup();
  ctx.Input.gamepadMapper[3] = 'ok';
  ctx.Input.gamepadMapper[2] = 'ok';
  ctx.sendInput(snapshot([], [], [], [pad([2, 3], [2, 3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);

  ctx.Input.gamepadMapper[3] = 'tag';
  ctx.sendInput(snapshot([], [], [], [pad([2, 3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  assert.equal(ctx.Input.isPressed('tag'), true);
});

test('gamepad remap includes a latched keyboard press', () => {
  const { context: ctx } = setup();
  ctx.Input.gamepadMapper[3] = 'ok';
  ctx.sendInput(snapshot([], [], [], [pad([3], [3])]));
  ctx.Input.update();

  ctx.Input.gamepadMapper[3] = 'tag';
  ctx.sendInput(snapshot([], [67], [], [pad([3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), true);
  assert.equal(ctx.Input.isPressed('tag'), true);
});

test('hidden disconnect never invokes a guest hook', () => {
  const { context: ctx } = setup();
  ctx.Input._updateGamepadState = () => { throw new Error('guest scene is not ready'); };
  ctx.sendInput(snapshot([], [], [], [pad()]));
  ctx.sendInput(snapshot());
  ctx.Input.update();
  assert.equal(ctx.navigator.getGamepads().length, 0);
});

test('disconnect reconciliation waits for polling and preserves keyboard ownership', () => {
  const { context: ctx } = setup();
  ctx.Input.gamepadMapper[3] = 'ok';
  ctx.sendInput(snapshot([67], [67], [key(67, true)], [pad([3])]));
  ctx.Input.update();
  let calls = 0;
  ctx.Input._updateGamepadState = () => { calls++; };
  ctx.sendInput(snapshot([67]));
  assert.equal(calls, 0);
  assert.equal(ctx.Input.isPressed('ok'), true);
  ctx.Input.update();
  assert.equal(calls, 0);
  assert.equal(ctx.Input.isPressed('ok'), true);
  ctx.sendInput(snapshot([], [], [key(67, false)]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('ok'), false);
});

test('device replacement and surviving controller retain shared actions', () => {
  const { context: ctx } = setup();
  const second = { ...pad([3]), index: 1, instance: 8 };
  ctx.sendInput(snapshot([], [], [], [pad(), { ...second, buttonsDown: [] }]));
  ctx.sendInput(snapshot([], [], [], [pad([3]), second]));
  ctx.Input.update();
  ctx.sendInput(snapshot([], [], [], [{ ...pad(), instance: 9 }, second]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('tag'), true);
  ctx.sendInput(snapshot([], [], [], [{ ...pad(), instance: 9 }]));
  ctx.Input.update();
  assert.equal(ctx.Input.isPressed('tag'), false);
});

test('input before gamepad observation cannot reach a scene-owned startup hook', () => {
  const { context: ctx } = setup(false);
  let scene = null;
  const original = ctx.Input._updateGamepadState;
  ctx.Input._updateGamepadState = function(gamepad) {
    original.call(this, gamepad);
    if (scene.overlay) scene.overlay++;
  };
  ctx.sendInput(snapshot([], [], [], [pad([3], [3], [0.7, 0, 0, 0])]));
  assert.doesNotThrow(() => ctx.Input.update());
  assert.equal(ctx.Input.isPressed('tag'), false);
  scene = { overlay: 1 };
  ctx.sendInput(snapshot([], [], [], [pad([3], [], [0.7, 0, 0, 0])]));
  ctx.Input.update();
  assert.equal(scene.overlay, 1, 'held startup controls remain hidden');
  ctx.sendInput(snapshot([], [], [], [pad()]));
  ctx.sendInput(snapshot([], [], [], [pad([3], [3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), true);
  assert.equal(scene.overlay, 2);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), false);
});

test('a tap released before observation is discarded and fresh short taps still trigger once', () => {
  const { context: ctx } = setup(false);
  ctx.sendInput(snapshot([], [], [], [pad([], [3])]));
  ctx.Input.update();
  ctx.sendInput(snapshot([], [], [], [pad()]));
  assert.equal(ctx.navigator.getGamepads().length, 0);
  assert.equal(ctx.Input.isPressed('tag'), false);
  ctx.sendInput(snapshot([], [], [], [pad([], [3])]));
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), true);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), false);
});

test('each initial control must reach rest before it can expose the controller', () => {
  const { context: ctx } = setup(false);
  ctx.navigator.getGamepads();
  ctx.sendInput(snapshot([], [], [], [pad([3], [3], [0.8, 0, 0, 0])]));
  ctx.sendInput(snapshot([], [], [], [pad([3], [], [0.1, 0, 0, 0])]));
  ctx.sendInput(snapshot([], [], [], [pad([3], [], [0.8, 0, 0, 0])]));
  assert.equal(ctx.navigator.getGamepads().length, 0, 'axis rest threshold is strictly below 0.1');
  ctx.sendInput(snapshot([], [], [], [pad([3], [], [0.099, 0, 0, 0])]));
  ctx.sendInput(snapshot([], [], [], [pad([3], [], [0.5, 0, 0, 0])]));
  assert.equal(ctx.navigator.getGamepads().length, 0, 'gesture threshold is strictly above 0.5');
  ctx.sendInput(snapshot([], [], [], [pad([3], [], [0.501, 0, 0, 0])]));
  const gamepad = ctx.navigator.getGamepads()[0];
  assert.equal(gamepad.axes[0], 0.501);
  assert.equal(gamepad.buttons[3].pressed, false, 'exposure does not unmask another held control');
  ctx.sendInput(snapshot([], [], [], [pad()]));
  ctx.sendInput(snapshot([], [], [], [pad([3], [3])]));
  assert.equal(gamepad.buttons[3].pressed, true);
});

test('gamepad exposure and connection events are asynchronous and preserve the triggering tap', () => {
  const { context: ctx, flushTasks } = setup();
  const events = [];
  ctx.addEventListener('gamepadconnected', event => events.push(event.gamepad));
  ctx.__pmjsReceiveInput(snapshot([], [], [], [pad([], [3])]));
  assert.equal(ctx.navigator.getGamepads().length, 0);
  assert.equal(events.length, 0);
  flushTasks();
  const gamepad = ctx.navigator.getGamepads()[0];
  assert.deepEqual(events, [gamepad]);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), true);
  ctx.sendInput(snapshot([], [], [], [pad()]));
  assert.equal(events.length, 1);
  ctx.Input.update();
  assert.equal(ctx.Input.isTriggered('tag'), false);
});

for (const subscribe of ['listener', 'handler']) {
  test('window gamepad ' + subscribe + ' starts observation without a getter', () => {
    const { context: ctx } = setup(false);
    const events = [];
    if (subscribe === 'listener') ctx.addEventListener('gamepadconnected', event => events.push(event));
    else ctx.ongamepadconnected = event => events.push(event);
    ctx.sendInput(snapshot([], [], [], [pad()]));
    ctx.sendInput(snapshot([], [], [], [pad([3], [3])]));
    assert.equal(events.length, 1);
    assert.equal(events[0].gamepad.buttons[3].pressed, true);
  });
}

test('replacement controllers get new neutral masks and stale connections are not published', () => {
  const { context: ctx, flushTasks } = setup();
  const connections = [], removals = [];
  ctx.addEventListener('gamepadconnected', event => connections.push(event.gamepad));
  ctx.addEventListener('gamepaddisconnected', event => removals.push(event.gamepad));
  ctx.sendInput(snapshot([], [], [], [pad([3])]));
  const original = ctx.navigator.getGamepads()[0];
  ctx.__pmjsReceiveInput(snapshot([], [], [], [{ ...pad([3]), instance: 9 }]));
  ctx.__pmjsReceiveInput(snapshot());
  flushTasks();
  assert.deepEqual(connections, [original]);
  assert.equal(removals[0], original);
  ctx.sendInput(snapshot([], [], [], [{ ...pad([3]), instance: 10 }]));
  assert.equal(ctx.navigator.getGamepads()[0].buttons[3].pressed, false);
  ctx.sendInput(snapshot([], [], [], [{ ...pad(), instance: 10 }]));
  ctx.sendInput(snapshot([], [], [], [{ ...pad([3]), instance: 10 }]));
  assert.equal(ctx.navigator.getGamepads()[0].buttons[3].pressed, true);
});

test('unfocused synthetic neutral input does not arm an initially held control', () => {
  const { context: ctx } = setup(false);
  ctx.navigator.getGamepads();
  ctx.__pmjsUpdateWindowState({ focused: false, visible: true });
  ctx.sendInput(snapshot([], [], [], [pad()]));
  ctx.__pmjsUpdateWindowState({ focused: true, visible: true });
  ctx.sendInput(snapshot([], [], [], [pad([3], [], [0.7, 0, 0, 0])]));
  assert.equal(ctx.navigator.getGamepads().length, 0);
  ctx.sendInput(snapshot([], [], [], [pad()]));
  ctx.sendInput(snapshot([], [], [], [pad([3], [3])]));
  assert.equal(ctx.navigator.getGamepads()[0].buttons[3].pressed, true);
});

for (const held of [false, true]) {
  test('a first ' + (held ? 'held press' : 'short tap') + ' survives logic steps before exposure is dispatched', () => {
    const { context: ctx, flushTasks } = setup();
    ctx.__pmjsReceiveInput(snapshot([], [], [], [pad(held ? [3] : [], [3])]));
    ctx.Input.update();
    assert.equal(ctx.Input.isTriggered('tag'), false);
    ctx.__pmjsReceiveInput(snapshot([], [], [], [pad()]));
    ctx.Input.update();
    flushTasks();
    ctx.Input.update();
    assert.equal(ctx.Input.isTriggered('tag'), true);
    ctx.Input.update();
    assert.equal(ctx.Input.isTriggered('tag'), false);
    assert.equal(ctx.Input.isPressed('tag'), false);
  });
}
