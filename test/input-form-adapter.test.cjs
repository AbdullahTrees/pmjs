'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const { createHostContext } = require('./helpers/mz-host-context.cjs');

function setup() {
  const c = createHostContext({ runtime: { env: () => '', windowSize: () => ({ width: 816, height: 624 }) } }, { graphics: false });
  let loaded, stop, pushed;
  const values = [];
  c.__pmjsBuiltinRequire = require;
  c.NativeHost.fs = { readText: () => 'reviewed form fixture' };
  c.Utils = { RPGMAKER_NAME: 'MV' };
  c.Window_NameInput = function() {};
  c.Window_Base = function() {};
  c.Scene_Base = function() {};
  c.Scene_Base.prototype.terminate = function() {};
  c.PMJS.plugins = { onLoaded(name, owner, fn) { loaded = fn; } };
  c.PMJS.tasks = { onStop(fn) { stop = fn; return () => { stop = null; }; } };
  c.Input = { clear() {}, form_mode: false };
  c.SceneManager = { snapForBackground() {}, push(Scene) { pushed = Scene; } };
  c.Game_Interpreter = function() {};
  c.Game_Interpreter.prototype.setWaitMode = function(mode) { this._waitMode = mode; };
  c.Game_Interpreter.prototype._inputForm = function(x, y, variable, maximum) {
    const input = c.document.createElement('input'); input.id = '_111_input';
    input.value = 'Initial'; input.maxLength = maximum;
    const submit = c.document.createElement('input'); submit.id = '_111_submit';
    submit.addEventListener('click', () => {
      values.push(input.value); input.remove(); submit.remove(); this.setWaitMode(''); c.Input.form_mode = false;
    });
    c.document.body.appendChild(input); c.document.body.appendChild(submit); input.focus();
    this.setWaitMode('input_form'); c.Input.form_mode = true;
  };
  const source = fs.readFileSync(require.resolve('../js/pmjs-plugins/input-form/native-form.js'), 'utf8')
    .replace(/'[a-f0-9]{64}'/, "'" + crypto.createHash('sha256').update('reviewed form fixture').digest('hex') + "'");
  vm.runInContext(source, c); loaded();
  return { c, values, stop: () => stop, Scene: () => pushed };
}

test('scene teardown submits the current form once and releases session resources', () => {
  const { c, values, stop, Scene } = setup();
  const interpreter = new c.Game_Interpreter(); interpreter._inputForm(20, 30, 1, 12, 0, 0, 40, 24, 'Initial');
  const scene = Object.create(Scene().prototype);
  scene._form = { submit: stop() };
  c.document.getElementById('_111_input').value = 'Changed';
  scene.terminate(); scene.terminate();
  assert.deepEqual(values, ['Changed']); assert.equal(interpreter._waitMode, '');
  assert.equal(c.Input.form_mode, false); assert.equal(c.document.getElementById('_111_input'), null);
  assert.equal(stop(), null); assert.equal(c.document.activeElement, c.document.body);
});
test('session stop completes the form and a failed scene push cannot strand input', () => {
  const { c, values, stop } = setup();
  const interpreter = new c.Game_Interpreter(); interpreter._inputForm(0, 0, 1, 12, 0, 0, 0, 24, 'Initial');
  stop()(); assert.equal(c.Input.form_mode, false); assert.deepEqual(values, ['Initial']);
  c.SceneManager.push = () => { throw new Error('scene failure'); };
  assert.throws(() => interpreter._inputForm(0, 0, 1, 12, 0, 0, 0, 24, 'Initial'), /scene failure/);
  assert.equal(c.Input.form_mode, false); assert.equal(interpreter._waitMode, ''); assert.equal(stop(), null);
});
