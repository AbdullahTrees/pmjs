'use strict';

function installPromiseRejectionBridge(hostProcess, { getTasks, reportUnhandled, reportHandled }) {
  const handled = new WeakMap();
  function deliver(callback) {
    const tasks = getTasks();
    if (!tasks || tasks.stopped) return;
    tasks.enqueue(callback, { errorMode: 'uncaught' });
  }
  function onUnhandled(reason, promise) {
    const tasks = getTasks();
    const origin = tasks && tasks.guestPromiseOrigin(promise);
    // Leave PMJS/host rejections outside explicit guest callback boundaries to Node.
    if (!origin) throw reason;
    handled.set(promise, origin);
    deliver(() => reportUnhandled(reason, promise, origin));
  }
  function onHandled(promise) {
    const origin = handled.get(promise);
    if (!origin) return;
    handled.delete(promise);
    deliver(() => reportHandled(promise, origin));
  }
  hostProcess.on('unhandledRejection', onUnhandled);
  hostProcess.on('rejectionHandled', onHandled);
  return function remove() {
    hostProcess.removeListener('unhandledRejection', onUnhandled);
    hostProcess.removeListener('rejectionHandled', onHandled);
  };
}

module.exports = { installPromiseRejectionBridge };
