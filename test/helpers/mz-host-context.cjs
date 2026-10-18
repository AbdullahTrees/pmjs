'use strict';

const vm = require('node:vm');
const { runModule } = require('./runtime-context.cjs');

function createHostContext(native, { graphics = true, now } = {}) {
  const runtime = Object.fromEntries(Object.entries(native.runtime).map(([name, value]) =>
    [name, typeof value === 'function' ? value.bind(native.runtime) : value]));
  runtime.now = now || runtime.now || (() => performance.now());
  const host = { ...native, runtime };
  const context = vm.createContext({ __pmjsBuiltinRequire: require, console, performance, Uint8Array, Uint8ClampedArray,
    PMJS: { config: { fonts: { GameFont: 'testfont.ttf' } } },
    NativeHost: host,
    trackNativeResource: resource => resource,
    releaseNativeResource: (resource, kind) => { if (resource) native[kind === 'canvas' ? 'canvas' : 'images'].release(resource.handle); },
    Input: { gamepadMapper: { 0: 'ok', 1: 'cancel' } }
  });
  for (const relative of ['js/pmjs-core/methods.js', 'js/pmjs-web/filesystem.js',
    'js/pmjs-web/runtime.js', 'js/pmjs-web/events.js', 'js/pmjs-web/canvas.js',
    ...require('./web-element-sources.cjs').elementSources,
    'js/pmjs-web/presentation.js', 'js/pmjs-web/fallback-font.js']) {
    runModule(context, relative);
  }
  if (graphics) {
    // A contained engine-contract fixture. Differential validation uses stock classes.
    const canvas = context.document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    canvas.style.width = '64px'; canvas.style.height = '64px';
    context.document.body.appendChild(canvas);
    context.Graphics = {
      width: 64, height: 64, _canvas: canvas, _realScale: 1,
      printError(name, message) {
        if (!this._errorPrinter) {
          this._errorPrinter = context.document.createElement('div');
          context.document.body.appendChild(this._errorPrinter);
        }
        const nameDiv = context.document.createElement('div');
        nameDiv.textContent = name;
        this._errorPrinter.innerHTML = nameDiv.outerHTML + message;
        canvas.style.opacity = 0.5;
      },
      showRetryButton(callback) {
        const button = context.document.createElement('button');
        button.id = 'retryButton'; button.innerHTML = 'Retry';
        button.onclick = () => { this.eraseError(); callback(); };
        this._errorPrinter.appendChild(button);
        button.focus();
      },
      eraseError() { this._errorPrinter.innerHTML = ''; canvas.style.opacity = 1; },
      pageToCanvasX(x) { return Math.round((x - canvas.offsetLeft) / this._realScale); },
      pageToCanvasY(y) { return Math.round((y - canvas.offsetTop) / this._realScale); }
    };
    runModule(context, 'js/pmjs-mz/graphics.js');
    context.PMJS.methods.install();
  }
  return context;
}

module.exports = { createHostContext };
