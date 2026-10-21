'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installPromiseRejectionBridge } = require('../runner/promise-rejections.cjs');

test('guest Promise rejection bridge preserves Node events and late handling', () => {
  const host = new EventEmitter(), queue = [], delivered = [];
  const origins = new WeakMap();
  const tasks = { stopped: false,
    guestPromiseOrigin: promise => origins.get(promise),
    enqueue(callback, options) { queue.push({ callback, options }); } };
  const remove = installPromiseRejectionBridge(host, {
    getTasks: () => tasks,
    reportUnhandled: (...args) => delivered.push(['unhandledRejection', ...args]),
    reportHandled: (...args) => delivered.push(['rejectionHandled', ...args])
  });
  try {
    const rejection = Promise.reject(new Error('guest rejection'));
    rejection.catch(() => {});
    origins.set(rejection, 'node');
    host.emit('unhandledRejection', 'reason', rejection);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].options.errorMode, 'uncaught');
    queue.shift().callback();
    host.emit('rejectionHandled', rejection);
    queue.shift().callback();
    assert.deepEqual(delivered, [
      ['unhandledRejection', 'reason', rejection, 'node'],
      ['rejectionHandled', rejection, 'node']
    ]);

    const browserRejection = Promise.reject(new Error('browser rejection'));
    browserRejection.catch(() => {});
    origins.set(browserRejection, 'browser');
    host.emit('unhandledRejection', 'browser reason', browserRejection);
    queue.shift().callback();
    assert.deepEqual(delivered.at(-1), ['unhandledRejection', 'browser reason', browserRejection, 'browser']);

    const infrastructureRejection = new Error('untracked rejection');
    assert.throws(() => host.emit('unhandledRejection', infrastructureRejection, {}),
      error => error === infrastructureRejection);
  } finally {
    remove();
  }
  assert.equal(host.listenerCount('unhandledRejection'), 0);
  assert.equal(host.listenerCount('rejectionHandled'), 0);
});
