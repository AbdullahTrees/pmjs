'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const { runModule } = require('./helpers/runtime-context.cjs');

const jsDir = path.resolve(__dirname, '../js');

test('MV platform lets a plugin create and register its own scene ticker', () => {
  const calls = [];
  class Ticker {
    add(callback) { calls.push(callback); }
    start() { this.started = true; }
  }
  const context = {
    Utils: {},
    PMJS: { config: {} },
    SceneManager: {},
    PIXI: { ticker: { Ticker } }
  };
  vm.createContext(context);
  runModule(context, 'js/pmjs-rpgmaker/platform.js');

  context.SceneManager.update = function() {};
  context.SceneManager.requestUpdate = function() {
    if (!this.ticker) {
      this.ticker = new context.PIXI.ticker.Ticker();
      this.ticker.add(this.update);
      this.ticker.start();
    }
  };
  context.SceneManager.requestUpdate();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], context.SceneManager.update);
  assert.equal(context.SceneManager.ticker.started, true);
});

test('FPSMeter defines the standard method surface, returns this from methods, and propagates library errors', () => {
  const stubContext = {
    window: {},
    NativeHost: { fs: { exists: () => false } }
  };
  vm.createContext(stubContext);
  runModule(stubContext, 'js/pmjs-mv/fpsmeter.js');

  assert.equal(typeof stubContext.FPSMeter, 'function');
  const meter = new stubContext.FPSMeter({ theme: 'transparent' });
  assert.equal(meter.tickStart(), meter);
  assert.equal(meter.tick(), meter);
  assert.equal(meter.show(), meter);
  assert.equal(meter.hide(), meter);
  assert.equal(meter.toggle(), meter);
  assert.equal(meter.pause(), meter);
  assert.equal(meter.resume(), meter);
  assert.equal(meter.destroy(), meter);

  const errorContext = {
    window: {},
    NativeHost: {
      fs: { exists: () => true },
      runtime: {
        loadScript: () => { throw new Error('syntax error in broken fpsmeter'); }
      }
    }
  };
  vm.createContext(errorContext);
  assert.throws(() => {
    runModule(errorContext, 'js/pmjs-mv/fpsmeter.js');
  }, /syntax error in broken fpsmeter/);
});

test('greenworks compatibility registers its supported module aliases', () => {
  const modules = {}, tasks = [];
  const context = {
    console, Buffer, __pmjsBuiltinRequire: require,
    NativeHost: { storage: { readText() { return null; }, writeText() {} } },
    PMJS: { config: { steam: { provider: 'portable', appId: 123456 } }, tasks: { enqueue(fn) { tasks.push(fn); } } },
    pmjsAchievements: {
      initialize: () => {},
      names: () => ['test'],
      isUnlocked: () => false,
      setUnlocked: () => true,
      getStat: () => 0,
      setStat: () => true,
      flush: () => true,
    },
    registerCommonJsModule(names, value) {
      for (const name of names) modules[name] = value;
    },
  };
  vm.createContext(context);
  runModule(context, 'js/pmjs-core/steam.js');
  runModule(context, 'js/pmjs-plugins/greenworks/compat.js');
  const gw = modules.greenworks;
  assert.equal(modules['./greenworks'], gw);
  assert.equal(gw.initAPI(), true);
  assert.equal(gw.isSteamRunning(), true);
  assert.equal(gw.getSteamId().isValid, true);
  assert.equal(gw.isSubscribedApp(), false);
  assert.equal(gw.isGameOverlayEnabled(), false);
  assert.equal(gw.isDLCInstalled(1), false);
  assert.equal(gw.getAppId(), 123456);

  let achievementResult = null;
  gw.activateAchievement('test', (res) => { achievementResult = res; });
  tasks.shift()();
  assert.equal(achievementResult, undefined);

  let statsResult = null;
  gw.storeStats((res) => { statsResult = res; });
  tasks.shift()();
  assert.equal(statsResult, undefined);
});

test('one physical host tick executes ticker, audio, video, and scheduled MV update', async () => {
  let tickerUpdates = 0;
  let audioPolls = 0;
  let videoUpdates = 0;
  let inputUpdates = 0;
  let managerUpdates = 0;
  let sceneUpdates = 0;

  const context = {
    console: console, __pmjsBuiltinRequire: require,
    performance: { now: () => 1000 },
    Math: Math,
    Number: Number,
    TypeError: TypeError,
    Map: Map,
    PMJS: { rpgmaker: { audio: { update: () => { audioPolls++; } } },
      web: { video: { update: () => { videoUpdates++; } } } },
    SceneManager: {
      _stopped: false,
      ticker: { _pmjsHostDriven: true, started: false, update: () => { tickerUpdates++; } },
      update() {
        this.updateManagers();
        this.updateMain();
      },
      updateManagers: () => { managerUpdates++; },
      updateMain() {
        this.updateInputData();
        this.changeScene();
        this.updateScene();
        this.requestUpdate();
      },
      updateInputData: () => { inputUpdates++; },
      changeScene: () => {},
      updateScene: () => { sceneUpdates++; },
      requestUpdate() {
        if (!this._stopped) {
          context.requestAnimationFrame(this.update.bind(this));
        }
      },
      _scene: { constructor: { name: 'Scene_Boot' } }
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  runModule(context, 'js/pmjs-web/scheduler.js');
  runModule(context, 'js/pmjs-rpgmaker/main-loop.js');
  runModule(context, 'js/pmjs-mv/main-loop.js');

  context.SceneManager.requestUpdate();

  assert.equal(typeof context.__pmjsTick, 'function');
  await context.__pmjsTick(1000);
  context.PMJS.tasks.stop();

  assert.equal(tickerUpdates, 1, 'Ticker should update exactly once per host tick');
  assert.equal(audioPolls, 1, 'Audio should poll exactly once per host tick');
  assert.equal(videoUpdates, 1, 'Video should update exactly once per host tick');
  assert.equal(inputUpdates, 1, 'Input should update exactly once per host tick');
  assert.equal(managerUpdates, 1, 'Managers should update exactly once per host tick');
  assert.equal(sceneUpdates, 1, 'Scene should update exactly once per host tick');
});

test('Scene_Map same-map transfer does not short-circuit through reuse and preserves stock transfer hooks', () => {
  let pluginHookCalls = 0;
  let playerTransferFinalized = false;

  const player = {
    _transferring: true,
    _newMapId: 10,
    _needsMapReload: false,
    isTransferring() { return this._transferring; },
    newMapId() { return this._newMapId; },
    performTransfer() {

      this._transferring = false;
      playerTransferFinalized = true;
    }
  };

  const map = {
    _mapId: 10,
    mapId() { return this._mapId; }
  };

  const origPerformTransfer = player.performTransfer;
  player.performTransfer = function() {
    pluginHookCalls++;
    return origPerformTransfer.apply(this, arguments);
  };

  function Scene_Base() {}
  function Scene_Map() {
    this._transfer = false;
  }
  Scene_Map.prototype = Object.create(Scene_Base.prototype);
  Scene_Map.prototype.constructor = Scene_Map;
  Scene_Map.prototype.updateTransferPlayer = function() {
    if (player.isTransferring()) {
      SceneManager.goto(Scene_Map);
    }
  };
  Scene_Map.prototype.onMapLoaded = function() {
    if (this._transfer) {
      player.performTransfer();
    }
  };

  const SceneManager = {
    _scene: null,
    _nextScene: null,
    _nextSceneSame: false,
    goto(sceneClass) {
      const newScene = new sceneClass();
      newScene._transfer = player.isTransferring();
      this._nextScene = newScene;
    }
  };

  const sandbox = {
    Utils: {},
    PMJS: { config: {} },
    SceneManager: SceneManager,
    Scene_Map: Scene_Map,
    $gamePlayer: player,
    $gameMap: map,
    NativeHost: { runtime: {} },
    nativeCompatibilityHit() {}
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  runModule(context, 'js/pmjs-rpgmaker/platform.js');

  assert.equal(context.Scene_Map.prototype._pmjsTransferPatched, undefined);

  const currentMapScene = new context.Scene_Map();
  currentMapScene.updateTransferPlayer();

  assert.ok(SceneManager._nextScene instanceof context.Scene_Map);
  assert.equal(SceneManager._nextSceneSame, false, '_nextSceneSame must not be set on stock same-map transfer');
  assert.equal(currentMapScene.reused, undefined, 'Scene_Map instance must not be marked reused by shared runtime');

  SceneManager._nextScene.onMapLoaded();
  assert.equal(pluginHookCalls, 1, 'Plugin performTransfer hook must execute exactly once');
  assert.equal(playerTransferFinalized, true, 'Player transfer state must be finalized normally');
  assert.equal(player.isTransferring(), false, 'Player isTransferring must be cleared');
});

test('Window_Base and Sprite_Base execute update without suppression', () => {
  let windowUpdated = 0;
  let spriteUpdated = 0;

  function Window_Base() { this.visible = false; }
  Window_Base.prototype.update = function() { windowUpdated++; };

  function Sprite_Base() {}
  Sprite_Base.prototype.update = function() { spriteUpdated++; };

  function Sprite_Picture() { Sprite_Base.call(this); }
  Sprite_Picture.prototype = Object.create(Sprite_Base.prototype);
  Sprite_Picture.prototype.picture = function() { return null; };

  const sandbox = {
    Tilemap: function() {},
    Window_Base: Window_Base,
    Sprite_Base: Sprite_Base,
    Sprite_Picture: Sprite_Picture
  };
  sandbox.Tilemap.prototype = {};
  const context = vm.createContext(sandbox);

  const win = new context.Window_Base();
  win.update();
  assert.equal(windowUpdated, 1, 'invisible Window_Base should not be suppressed');

  const pic = new context.Sprite_Picture();
  pic.update();
  assert.equal(spriteUpdated, 1, 'Sprite_Picture with null picture should not be suppressed');
});

test('Bitmap.prototype.drawText installs native acceleration only for stock pipeline and respects overrides', () => {
  const { createHostContext } = require('./helpers/mz-host-context.cjs');
  let stockOutlineCalls = 0;
  let customOutlineCalls = 0;
  let nativeDrawCalls = 0;
  let nativeDrawArguments = [];

  function makeMockBitmapClass(customDrawText) {
    function MockBitmap() {
      this.width = 100;
      this.height = 100;
      this.fontSize = 16;
      this.outlineWidth = 2;
      this.outlineColor = '#000000';
      this.textColor = '#ffffff';
      this._canvas = MockBitmap.makeCanvas();
      this._canvas.width = this.width; this._canvas.height = this.height;
      this._context = this._canvas.getContext('2d');
    }
    MockBitmap.prototype._makeFontNameText = function() { return '16px sans-serif'; };
    MockBitmap.prototype._setDirty = function() {};
    // Raster leaves count ordinary dispatch; the surrounding Canvas state is real.
    MockBitmap.prototype._drawTextOutline = function() {
      stockOutlineCalls++;
    };
    MockBitmap.prototype._drawTextBody = function() {};
    MockBitmap.prototype.drawText = customDrawText || function(text, x, y, maxWidth, lineHeight, align) {
      if (text !== undefined) {
        var tx = x;
        var ty = y + lineHeight - (lineHeight - this.fontSize * 0.7) / 2;
        var context = this._context;
        var alpha = context.globalAlpha;
        maxWidth = maxWidth || 0xffffffff;
        context.save();
        context.font = this._makeFontNameText();
        this._drawTextOutline(text, tx, ty, maxWidth);
        this._drawTextBody(text, tx, ty, maxWidth);
        context.restore();
        this._setDirty();
      }
    };
    return MockBitmap;
  }

  function createContext(BitmapClass, disabled = false) {
    nativeDrawCalls = 0;
    nativeDrawArguments = [];
    const native = {
      runtime: { env() { return ''; }, loadScript() {} },
      render: {},
      canvas: {
        create(width, height) { return { handle: 1, width, height }; },
        release() {}, clear() {},
        measureText: function() { return 50; },
        drawText: function() {
          nativeDrawCalls++;
          nativeDrawArguments.push(Array.from(arguments));
        }
      }
    };
    const context = createHostContext(native, { graphics: false });
    Object.assign(context, { Bitmap: BitmapClass, Sprite: function() {},
      Graphics: Object.assign(function() {}, { width: 100, height: 100 }),
      Input: function() {}, nativeBootPhase: function() {} });
    BitmapClass.makeCanvas = () => context.document.createElement('canvas');
    context.PMJS.config.disableOptimizations = disabled ? ['bitmap.native-draw-text'] : [];
    runModule(context, 'js/pmjs-core/optimizations.js');
    runModule(context, 'js/pmjs-mv/bitmap.js');
    return context;
  }

  const StockBitmap = makeMockBitmapClass();
  const stockContext = createContext(StockBitmap);
  const stockBmp = new stockContext.Bitmap();
  stockBmp.drawText('hello', 0, 0, 0, 20, 'left');
  assert.equal(nativeDrawCalls > 0, true, 'stock methods should use native fast path');
  assert.equal(stockOutlineCalls, 0, 'stock outline should not be called when native fast-path runs');
  nativeDrawCalls = 0;
  stockBmp.drawText('constrained', 0, 0, 12, 20, 'left');
  assert.equal(nativeDrawCalls, 0, 'constrained text must keep Canvas maxWidth');
  assert.equal(stockOutlineCalls, 1);
  stockBmp.drawText('centered', 0, 0, 0, 20, 'center');
  assert.equal(nativeDrawCalls, 0, 'unconstrained alignment must keep stock positioning');
  assert.equal(stockOutlineCalls, 2);
  nativeDrawCalls = 0;
  stockBmp._context.globalAlpha = 0.25;
  stockBmp.drawText('alpha', 10, 0, 0, 20, 'left');
  assert.equal(nativeDrawArguments.at(-2)[6] & 255, 255,
    'outline preserves MV globalAlpha=1 behavior');
  assert.equal(nativeDrawArguments.at(-1)[6] & 255, 63,
    'body preserves the caller globalAlpha');
  nativeDrawCalls = 0;
  stockBmp.drawText(undefined, 0, 0, 0, 20, 'left');
  assert.equal(nativeDrawCalls, 0, 'undefined text must not draw');
  stockBmp._context._transform = [1, 0, 0, 1, 40, 0];
  stockBmp.drawText('translated', 10, 0, 0, 20, 'left');
  assert.equal(nativeDrawCalls, 0, 'translated text must retain Canvas path');
  stockBmp._context._transform = [1, 0, 0, 1, 0, 0];
  stockBmp._context.beginPath();
  stockBmp._context.rect(0, 0, 20, 20);
  stockBmp._context.clip();
  stockBmp.drawText('clipped', 10, 0, 0, 20, 'left');
  assert.equal(nativeDrawCalls, 0, 'clipped text must retain Canvas path');

  let pluginDrawCalls = 0;
  const PreModifiedBitmap = makeMockBitmapClass(function(text) {
    pluginDrawCalls++;
    this._drawTextBody(text, 0, 0, 100);
  });
  const preModifiedContext = createContext(PreModifiedBitmap);
  const preModifiedBmp = new preModifiedContext.Bitmap();
  preModifiedBmp.drawText('custom');
  assert.equal(pluginDrawCalls, 1, 'pre-modified drawText must not be replaced');
  assert.equal(nativeDrawCalls, 0, 'native drawText must not run for non-stock pipeline');

  const customBmp = new stockContext.Bitmap();
  customBmp._drawTextOutline = function() { customOutlineCalls++; };
  customBmp.drawText('hello', 0, 0, 100, 20, 'left');
  assert.equal(customOutlineCalls, 1, 'overridden _drawTextOutline must be invoked via fallback');
  const DisabledBitmap = makeMockBitmapClass();
  const disabledContext = createContext(DisabledBitmap, true);
  new disabledContext.Bitmap().drawText('ordinary', 0, 0, 0, 20, 'left');
  assert.equal(nativeDrawCalls, 0, 'disabled text optimization must keep the ordinary path');
  assert.equal(disabledContext.PMJS.optimizations.reason('bitmap.native-draw-text'), 'disabled by configuration');
});
