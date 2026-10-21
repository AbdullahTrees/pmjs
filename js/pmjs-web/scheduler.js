'use strict';

(function() {
  var host = typeof NativeHost !== 'undefined' && NativeHost.runtime && NativeHost.runtime.scheduling ||
    globalThis.__pmjsBuiltinRequire('node:timers');
  var nextId = 1;
  var tasks = [], head = 0, continuations = [];
  var scheduled = null, stopped = false, rendering = false, frame = null;
  var clock = performance.now.bind(performance);
  var frameTasks = 0, frameStartedAt = 0, idleWaiters = [];
  var stopListeners = new Set();
  var rafs = new Map(), timers = new Map(), timerWake = null;

  function report(error) {
    if (typeof pmjsReportEventError === 'function') pmjsReportEventError(error);
    else console.error('[pmjs] async error:', error);
  }
  function reportUncaught(error) {
    if (typeof pmjsReportNodeException === 'function') pmjsReportNodeException(error);
    else console.error('[pmjs] uncaught exception in Node callback:', error);
  }
  function wake() {
    if (!stopped && scheduled === null) scheduled = host.setImmediate(step);
  }
  function discard(options) {
    if (!options.discard) return;
    try { options.discard(); } catch (error) { report(error); }
  }
  function enqueue(callback, options) {
    options = options || {};
    if (stopped) {
      discard(options);
      return false;
    }
    tasks.push({ callback: callback, options: options });
    wake();
    return true;
  }
  function invoke(callback, errorMode, renderingCallback) {
    return new Promise(function(resolve, reject) {
      var entry = { callback: function() {
        try { resolve(callback()); }
        catch (error) {
          if (errorMode === 'event') { report(error); resolve(); }
          else reject(error);
        }
      }, options: { discard: function() { resolve(); } } };
      if (stopped) { resolve(); return; }
      if (rendering && renderingCallback) continuations.push(entry);
      else tasks.push(entry);
      wake();
    });
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    if (scheduled !== null) host.clearImmediate(scheduled);
    if (timerWake !== null) host.clearTimeout(timerWake);
    scheduled = timerWake = null;
    timers.clear(); rafs.clear();
    stopListeners.forEach(function(callback) { try { callback(); } catch (error) { report(error); } });
    stopListeners.clear();
    var discarded = tasks.slice(head).concat(continuations);
    tasks = []; head = 0; continuations = [];
    discarded.forEach(function(entry) {
      discard(entry.options);
    });
    if (frame) { frame.resolve(); frame = null; }
    idleWaiters.splice(0).forEach(function(resolve) { resolve(); });
  }
  function fatal(error) {
    stop();
    if (typeof host.onFatal === 'function') host.onFatal(error);
    else throw error;
  }
  function step() {
    scheduled = null;
    if (stopped) return;
    // Bound resource admission across host turns without losing Promise checkpoints.
    if (!rendering && frame && (head === tasks.length || frameTasks >= 64 ||
      (frameTasks > 0 && clock() - frameStartedAt >= 4))) {
      var active = frame; frame = null;
      rendering = true;
      var result;
      try { result = active.callback(); }
      catch (error) { rendering = false; active.reject(error); return; }
      Promise.resolve(result).then(function(value) {
        rendering = false; active.resolve(value); wake();
      }, function(error) {
        rendering = false; active.reject(error); wake();
      });
      return;
    }
    var entry;
    if (rendering) entry = continuations.shift();
    else if (head < tasks.length) { entry = tasks[head]; tasks[head++] = null; }
    if (!entry) {
      if (!rendering) {
        tasks = []; head = 0;
        idleWaiters.splice(0).forEach(function(resolve) { resolve(); });
      }
      return;
    }
    if (!rendering && frame) {
      if (frameTasks === 0) frameStartedAt = clock();
      frameTasks++;
    }
    try { entry.callback(); }
    catch (error) {
      if (entry.options.errorMode === 'event') report(error);
      else if (entry.options.errorMode === 'uncaught') reportUncaught(error);
      else { fatal(error); return; }
    }
    if (!rendering && head >= tasks.length) { tasks = []; head = 0; }
    // Amortize compaction across the queue; consumed slots release callbacks above.
    else if (!rendering && head > 64 && head * 2 >= tasks.length) { tasks.splice(0, head); head = 0; }
    // Return to Node even when the last callback only queues Promise work.
    wake();
  }
  PMJS.tasks = {
    enqueue: enqueue,
    invoke: invoke,
    invokeRendering: function(callback, errorMode) { return invoke(callback, errorMode, true); },
    idle: function() {
      return new Promise(function(resolve) {
        if (stopped) resolve();
        else { idleWaiters.push(resolve); wake(); }
      });
    },
    runFrame: function(callback) {
      return new Promise(function(resolve, reject) {
        if (stopped) { resolve(); return; }
        if (frame || rendering) { reject(new Error('overlapping rendering phases')); return; }
        frame = { callback: callback, resolve: resolve, reject: reject };
        frameTasks = 0;
        wake();
      });
    },
    stop: stop,
    onStop: function(callback) {
      if (stopped) callback();
      else stopListeners.add(callback);
      return function() { stopListeners.delete(callback); };
    },
    get stopped() { return stopped; }
  };

  function armTimers() {
    if (timerWake !== null) host.clearTimeout(timerWake);
    timerWake = null;
    if (stopped) return;
    var deadline = Infinity;
    timers.forEach(function(timer) {
      if (!timer.queued) deadline = Math.min(deadline, timer.deadline);
    });
    if (deadline !== Infinity) timerWake = host.setTimeout(queueDueTimers,
      Math.max(0, deadline - performance.now()));
  }
  function queueDueTimers() {
    timerWake = null;
    var now = performance.now(), due = [];
    timers.forEach(function(timer) {
      if (!timer.queued && timer.deadline <= now) due.push(timer);
    });
    due.sort(function(a, b) { return a.deadline - b.deadline || a.id - b.id; });
    due.forEach(function(timer) {
      timer.queued = true;
      enqueue(function() {
        if (!timers.has(timer.id)) return;
        if (!timer.interval) timers.delete(timer.id);
        try {
          if (typeof timer.callback === 'function') timer.callback.apply(globalThis, timer.args);
          else if (typeof timer.callback === 'string') (0, eval)(timer.callback);
        } finally {
          if (timer.interval && timers.has(timer.id)) {
            var now = performance.now();
            timer.deadline += Math.max(1, Math.floor((now - timer.deadline) / timer.interval) + 1) * timer.interval;
            timer.queued = false;
          }
          armTimers();
        }
      }, { errorMode: 'event' });
    });
    armTimers();
  }
  function addTimer(callback, delay, interval, args) {
    var id = nextId++;
    delay = Math.max(interval ? 1 : 0, Number(delay) || 0);
    if (!stopped) {
      timers.set(id, { id: id, callback: callback, args: args,
        deadline: performance.now() + delay, interval: interval ? delay : 0, queued: false });
      armTimers();
    }
    return id;
  }
  function clearTimer(id) { timers.delete(id); armTimers(); }
  globalThis.setTimeout = function(callback, delay) {
    return addTimer(callback, delay, false, Array.prototype.slice.call(arguments, 2));
  };
  globalThis.setInterval = function(callback, delay) {
    return addTimer(callback, delay, true, Array.prototype.slice.call(arguments, 2));
  };
  globalThis.clearTimeout = globalThis.clearInterval = clearTimer;
  globalThis.requestAnimationFrame = function(callback) {
    if (typeof callback !== 'function') throw new TypeError('requestAnimationFrame callback must be a function');
    var id = nextId++;
    if (!stopped) rafs.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = function(id) { rafs.delete(id); };
  globalThis.pmjsDrainScheduler = function(now) {
    if (typeof now !== 'number') now = performance.now();
    var snapshot = Array.from(rafs.keys());
    var chain = Promise.resolve();
    snapshot.forEach(function(id) {
      chain = chain.then(function() {
        return invoke(function() {
          var callback = rafs.get(id);
          if (!callback) return;
          rafs.delete(id);
          callback(now);
        }, 'event', true);
      });
    });
    return chain;
  };
})();
