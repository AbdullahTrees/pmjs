'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { runModule } = require('./helpers/runtime-context.cjs');
const jsDir = path.resolve(__dirname, '../js');

function markTestRenderers(context) {
  const renderers = new WeakSet();
  const create = context.createNativePixiRenderer;
  context.createNativePixiRenderer = function(...args) {
    const renderer = create(...args);
    renderers.add(renderer);
    return renderer;
  };
  context.PMJS.pixi4 = { isNativeRenderer: value => renderers.has(value) };
}

test('MV rejects a nondelegating browser renderer and records its plugin mutation', () => {
  const context = vm.createContext({ console, Graphics: {},
    createNativePixiRenderer() { return { render() {} }; } });
  runModule(context, 'js/pmjs-core/methods.js');
  markTestRenderers(context);
  const source = fs.readFileSync(path.join(jsDir, 'pmjs-mv/renderer.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('var originalIsOptionValid')), context);
  const token = context.PMJS.methods.beginPlugin('ReplacementRenderer');
  let setups = 0;
  context.Graphics._createRenderer = function() {
    setups++;
    this._renderer = { render() {}, gl: {}, _pmjsNative: true };
  };
  context.PMJS.methods.endPlugin(token);
  context.PMJS.methods.install();
  assert.throws(() => context.Graphics._createRenderer(), /must create a PMJS native renderer/);
  assert.equal(setups, 1);
  const record = context.PMJS.methods.dump().find(value => value.key === 'Graphics._createRenderer');
  assert.equal(record.mutations[0].plugin, 'ReplacementRenderer');
});

test('MV accepts a replacement that creates a native renderer and preserves return and errors', () => {
  const context = vm.createContext({ console, Graphics: {},
    createNativePixiRenderer() { return { render() {} }; } });
  runModule(context, 'js/pmjs-core/methods.js');
  markTestRenderers(context);
  const source = fs.readFileSync(path.join(jsDir, 'pmjs-mv/renderer.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('var originalIsOptionValid')), context);
  let fail = false;
  const error = new Error('guest setup failed');
  context.Graphics._createRenderer = function() {
    if (fail) throw error;
    this._renderer = context.createNativePixiRenderer();
    this._renderer.guestReady = true;
    return 'created';
  };
  context.PMJS.methods.install();
  assert.equal(context.Graphics._createRenderer(), 'created');
  assert.equal(context.Graphics._renderer.guestReady, true);
  fail = true;
  assert.throws(() => context.Graphics._createRenderer(), value => value === error);
});

test('native presentation ownership is restored without discarding guest renderer creation', () => {
  const source = fs.readFileSync(path.join(jsDir, 'pmjs-mv/renderer.js'), 'utf8');

  const rendererInstaller = source.slice(0, source.indexOf('var originalIsOptionValid'));
  const context = {
    console,
    Graphics: { frameCount: 0 },
    createNativePixiRenderer() { return { render() {}, gl: null }; },
  };
  context.globalThis = context;
  vm.createContext(context);
  runModule(context, 'js/pmjs-core/methods.js');
  markTestRenderers(context);
  vm.runInContext(rendererInstaller, context);
  const baseCreateRenderer = context.Graphics._createRenderer;
  let pluginCreates = 0;
  const pluginCreateRenderer = function() {
    pluginCreates++;
    return baseCreateRenderer.apply(this, arguments);
  };
  const pluginRender = function() {};
  context.Graphics._createRenderer = pluginCreateRenderer;
  context.Graphics.render = pluginRender;
  context.PMJS.methods.install();

  assert.notEqual(context.Graphics._createRenderer, pluginCreateRenderer);
  assert.notEqual(context.Graphics.render, pluginRender);
  context.Graphics._createRenderer();
  assert.equal(pluginCreates, 1);
  assert.equal(typeof context.Graphics._renderer.render, 'function');
  context.Graphics.frameCount = 1023;
  context.Graphics.render({});
  assert.equal(context.Graphics.frameCount, 1024,
    'MV frame count must continue past the former renderer wraparound');
  context.Graphics.frameCount = 60 * 60 * 24;
  context.Graphics.render(null);
  assert.equal(context.Graphics.frameCount, 60 * 60 * 24 + 1,
    'a loaded playtime frame count must survive the next presentation');
});

for (const composition of ['alias', 'subclass']) {
  test(`MV renderer preserves ${composition} setup, defaults and post-creation behavior`, () => {
    for (const roundPixels of [false, true]) {
      const source = fs.readFileSync(path.join(jsDir, 'pmjs-mv/renderer.js'), 'utf8');
      const context = {
        console,
        calls: [],
        roundPixels,
        PIXI: { settings: { RENDER_OPTIONS: { roundPixels: false } } },
        createNativePixiRenderer(w, h, options) {
          context.calls.push('create');
          return { width: w, height: h, view: options.view,
            roundPixels: context.PIXI.settings.RENDER_OPTIONS.roundPixels };
        },
      };
      context.globalThis = context;
      vm.createContext(context);
      vm.runInContext(`
        var Graphics = class {
          static _createRenderer() { throw new Error('Browser renderer reached'); }
          static render() {}
        };
        Graphics._width = 640;
        Graphics._height = 480;
        Graphics._canvas = {};
      `, context);
      runModule(context, 'js/pmjs-core/methods.js');
      markTestRenderers(context);
      vm.runInContext(source.slice(0, source.indexOf('var originalIsOptionValid')), context);
      const preparation = `
        calls.push('prepare');
        if (roundPixels) PIXI.settings.RENDER_OPTIONS.roundPixels = true;
        this._width = 960;
      `;
      vm.runInContext(composition === 'alias' ? `
        var parentCreateRenderer = Graphics._createRenderer;
        Graphics._createRenderer = function() {
          ${preparation}
          parentCreateRenderer.apply(this, arguments);
          calls.push('post');
          this._renderer.guestReady = true;
        };
      ` : `
        Graphics = class extends Graphics {
          static _createRenderer() {
            ${preparation}
            super._createRenderer();
            calls.push('post');
            this._renderer.guestReady = true;
          }
        };
      `, context);
      context.PMJS.methods.install();
      context.PMJS.methods.install();
      context.Graphics._createRenderer();
      assert.deepEqual(context.calls, ['prepare', 'create', 'post']);
      assert.equal(context.Graphics._renderer.roundPixels, roundPixels);
      assert.equal(context.Graphics._renderer.width, 960);
      assert.equal(context.Graphics._renderer.height, 480);
      assert.equal(context.Graphics._renderer.view, context.Graphics._canvas);
      assert.equal(context.Graphics._renderer.guestReady, true);
      context.calls.length = 0;
      context.Graphics._createRenderer();
      assert.deepEqual(context.calls, ['prepare', 'create', 'post']);
    }
  });
}

test('Graphics._createRenderer uses the game-authored logical dimensions', () => {
  const source = fs.readFileSync(path.join(jsDir, 'pmjs-mv/renderer.js'), 'utf8');

  const rendererInstaller = source.slice(0, source.indexOf('var originalIsOptionValid'));
  const createdSizes = [];
  const context = {
    console,
    Graphics: { _width: 960, _height: 720, frameCount: 0, _createRenderer() {} },
    __pmjsGameInfo: { width: 816, height: 624, title: 'Test' },
    createNativePixiRenderer(w, h) {
      createdSizes.push({ w, h });
      return {
        render() {},
        gl: null
      };
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  runModule(context, 'js/pmjs-core/methods.js');
  markTestRenderers(context);
  vm.runInContext(rendererInstaller, context);
  context.PMJS.methods.install();

  context.Graphics._createRenderer();
  assert.deepEqual(createdSizes, [{ w: 960, h: 720 }]);
});
