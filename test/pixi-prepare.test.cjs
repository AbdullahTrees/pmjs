'use strict';

const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function harness() {
  const tasks = [];
  const context = vm.createContext({ performance, PIXI: {}, PMJS: { tasks: {
    enqueue(callback) { tasks.push(callback); }
  } } });
  vm.runInContext(fs.readFileSync(require.resolve('../js/pmjs-pixi4/renderer-managers.js'), 'utf8'), context);
  return { plugin: new context.NativePreparePlugin(), drain() { tasks.splice(0).forEach(callback => callback()); } };
}

test('prepare destruction detaches pending source listeners and cancels completion', () => {
  const h = harness(), source = Object.assign(new EventTarget(), { complete: false });
  let completed = 0;
  h.plugin.upload({ baseTexture: { source } }, () => completed++);
  assert.equal(getEventListeners(source, 'load').length, 1);
  h.plugin.destroy();
  assert.equal(getEventListeners(source, 'load').length, 0);
  assert.equal(getEventListeners(source, 'error').length, 0);
  source.dispatchEvent(new Event('load'));
  h.drain();
  assert.equal(completed, 0);
  assert.equal(h.plugin._activeUploads, 0);
});

test('destroy cancels already queued completion and ignores subsequent upload requests', () => {
  const h = harness();
  h.plugin.upload(() => assert.fail('completion after destruction'));
  h.plugin.destroy();
  h.plugin.upload(() => assert.fail('upload after destruction'));
  h.drain();
});

test('independent preparations sharing a callback settle once each on load or error', () => {
  const h = harness(), source = Object.assign(new EventTarget(), { complete: false });
  let completed = 0;
  const done = () => completed++;
  for (let i = 0; i < 2; i++) h.plugin.upload({ baseTexture: { source } }, done);
  source.dispatchEvent(new Event('error'));
  source.dispatchEvent(new Event('load'));
  h.drain();
  assert.equal(completed, 2);
  assert.equal(h.plugin._activeUploads, 0);
  assert.equal(h.plugin.ticking, false);
  assert.equal(getEventListeners(source, 'load').length, 0);
});
