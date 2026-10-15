'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createStorage } = require('../runner/storage.cjs');

function desktop(engine) {
  const root = temporaryDirectory('desktop-');
  const game = createStorage(path.join(root, 'game'));
  const save = createStorage(path.join(root, 'save'));
  const queue = [], stops = [];
  let stopped = false, clipboard = '', quits = 0, reloads = 0, released = 0;
  const state = { x: 10, y: 20, width: 640, height: 480, fullscreen: false };
  const context = vm.createContext({ Buffer, console, process, performance, PMJS_RUNTIME_ENGINE: engine, __pmjsBuiltinRequire: require,
    PMJS: { config: {}, web: {}, compat: { hit() {} }, tasks: {
      enqueue(fn) { if (stopped) return false; queue.push(fn); return true; },
      onStop(fn) { stops.push(fn); }
    } },
    NativeHost: { storage: save, fs: game, runtime: {
      env() { return ''; }, now: () => 0, windowState() { return { ...state }; }, isFullscreen: () => state.fullscreen,
      arguments: ['test', 'flag'], quit() { quits++; }, reload() { reloads++; },
      windowSize: () => ({ width: state.width, height: state.height }),
      windowCommand(name, x, y) {
        if (name === 'move') { state.x = x; state.y = y; }
        if (name === 'resize') { state.width = x; state.height = y; }
      },
      clipboardText(...args) { if (args.length) clipboard = args[0]; return clipboard; },
      openExternal() { return true; }
    }, canvas: { captureDrawable: () => ({ handle: 1 }), encodePng: () => Buffer.from('png'),
      encodeJpeg: () => Buffer.from('jpeg'), release() { released++; } } }
  });
  game.writeText('package.json', '{"name":"test-game","version":"1.2.3"}');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-rpgmaker/lifecycle.js'), 'utf8'), context);
  for (const file of ['runtime', 'filesystem', 'modules']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/' + file + '.js'), 'utf8'), context);
  }
  return { context, game, save, state, root, drain() { while (queue.length) queue.shift()(); },
    stop() { stopped = true; queue.length = 0; stops.forEach(fn => fn()); },
    get quits() { return quits; }, get reloads() { return reloads; }, get released() { return released; } };
}

test('desktop identity, manifest, arguments and CommonJS packages agree before plugins run', () => {
  const h = desktop(), c = h.context;
  h.game.writeText('node_modules/library/package.json', '{"main":"dist/main"}');
  h.game.writeText('node_modules/library/dist/main.js', 'exports.value = require("./values.json").answer; exports.file = __filename; exports.main = require.main.filename; exports.cached = require.cache[module.filename] === module;');
  h.game.writeText('node_modules/library/dist/values.json', '{"answer":42}');
  h.game.writeText('cycle/a.js', 'exports.before=true; exports.b=require("./b");');
  h.game.writeText('cycle/b.js', 'module.exports=require("./a").before;');
  const result = c.require('library');
  assert.equal(result.value, 42);
  assert.equal(result.file, '/game/node_modules/library/dist/main.js');
  assert.equal(result.main, '/game/index.html');
  assert.equal(result.cached, true);
  assert.equal(c.require('library'), result);
  assert.equal(c.require.resolve('library'), result.file);
  assert.equal(c.require('./cycle/a').b, true);
  assert.equal(c.require('events'), require('events'));
  assert.equal(c.require('node:fs'), c.require('fs'));
  assert.equal(c.require('nw.gui'), c.nw);
  assert.equal(c.nw.App.manifest.name, 'test-game');
  assert.deepEqual(Array.from(c.nw.App.argv), ['test', 'flag']);
  assert.equal(c.process.mainModule, c.require.main);
  assert.equal(c.process.versions.nw, c.process.versions['node-webkit']);
  assert.equal(c.process.versions['nw-flavor'], 'sdk');
  assert.equal(c.process.env.APPDATA, '/save/');
  assert.throws(() => c.require('absent'), { code: 'MODULE_NOT_FOUND' });
  h.game.writeText('broken.js', 'throw new Error("broken module");');
  assert.throws(() => c.require('./broken'), /broken module/);
  h.game.writeText('broken.js', 'module.exports = 99;');
  assert.equal(c.require('./broken'), 99);
});

test('filesystem metadata, directory operations, callback and Promise results preserve errors', async () => {
  const h = desktop(), guest = h.context.require('fs');
  guest.mkdirSync('/save/data');
  guest.writeFileSync('/save/data/a.txt', 'é');
  const stat = guest.statSync('/save/data/a.txt');
  assert.equal(stat.size, 2);
  assert.ok(stat.mtime instanceof Date);
  assert.equal(stat.isFile(), true);
  assert.equal(guest.lstatSync('/save/data').isDirectory(), true);
  assert.equal(guest.accessSync('/save/data/a.txt', guest.constants.R_OK), undefined);
  assert.throws(() => guest.accessSync('/save/missing'), { code: 'ENOENT', path: '/save/missing' });
  assert.equal(guest.statSync('/save/missing', { throwIfNoEntry: false }), undefined);
  assert.throws(() => guest.readdirSync('/save/data/a.txt'), { code: 'ENOTDIR' });
  assert.throws(() => guest.mkdirSync('/save/data'), { code: 'EEXIST' });
  assert.throws(() => guest.unlinkSync('/save/data'), { code: 'EISDIR' });
  assert.throws(() => guest.rmdirSync('/save/data'), { code: 'ENOTEMPTY' });
  const entries = guest.readdirSync('/save/data', { withFileTypes: true });
  assert.equal(entries[0].name, 'a.txt');
  assert.equal(entries[0].isFile(), true);
  let callback;
  guest.lstat('/save/data/a.txt', (error, result) => { assert.equal(error, null); callback = result.size; });
  assert.equal(callback, undefined);
  h.drain();
  assert.equal(callback, 2);
  const pending = guest.promises.stat('/save/data/a.txt');
  h.drain();
  assert.equal((await pending).size, 2);
  guest.rmSync('/save/data', { recursive: true });
  assert.equal(guest.existsSync('/save/data'), false);
});

test('window state, subscriptions, close interception, menus and clipboard have observable behavior', () => {
  const h = desktop(), c = h.context, win = c.nw.Window.get();
  win.resizeTo(800, 600); win.moveTo(30, 40);
  assert.equal(c.outerWidth, 800); assert.equal(win.width, 800);
  assert.equal(c.innerWidth, 800);
  assert.equal(c.nativeLogicalWidth, 640, 'physical resize preserves authored logical size');
  assert.equal(win.x, c.screenX); assert.equal(win.y, 40);
  let closes = 0, moved = [];
  const listener = () => { closes++; };
  win.on('close', listener);
  win.close(); assert.equal(closes, 1); assert.equal(h.quits, 0);
  win.close(true); assert.equal(closes, 1); assert.equal(h.quits, 1);
  win.removeListener('close', listener);
  win.once('move', (x, y) => moved.push([x, y]));
  c.__pmjsDispatchWindowEvents([{ type: 'move', x: 3, y: 4 }, { type: 'move', x: 5, y: 6 }]);
  assert.deepEqual(moved, [[3, 4]]);
  const clipboard = c.nw.Clipboard.get();
  clipboard.set('é'); assert.equal(clipboard.get(), 'é'); clipboard.clear(); assert.equal(clipboard.get(), '');
  const menu = new c.nw.Menu(), item = new c.nw.MenuItem({ label: 'Entry', checked: true });
  menu.append(item); assert.equal(menu.items[0], item); menu.remove(item); assert.equal(menu.items.length, 0);
  assert.throws(() => c.nw.Window.open('editor.html'), { code: 'ERR_NW_UNSUPPORTED_WINDOW' });
  c.location.reload(); c.chrome.runtime.reload(); win.reload(); assert.equal(h.reloads, 3);
});

test('capture waits for presentation, returns requested formats, releases resources and drops terminated callbacks', () => {
  const h = desktop(), c = h.context, win = c.nw.Window.get(), values = [];
  win.capturePage(value => values.push(value), { format: 'png', datatype: 'buffer' });
  win.capturePage(value => values.push(value), { format: 'jpeg', datatype: 'raw' });
  win.capturePage(value => values.push(value), { format: 'png' });
  assert.equal(values.length, 0); assert.equal(h.released, 0);
  c.__pmjsAfterPresent(); assert.equal(values.length, 0); assert.equal(h.released, 3);
  h.drain();
  assert.ok(Buffer.isBuffer(values[0])); assert.equal(values[0].toString(), 'png');
  assert.equal(values[1], Buffer.from('jpeg').toString('base64'));
  assert.equal(values[2], 'data:image/png;base64,' + Buffer.from('png').toString('base64'));
  win.capturePage(() => assert.fail('callback after shutdown'));
  h.stop(); c.__pmjsAfterPresent(); h.drain(); assert.equal(h.released, 3);
});

test('desktop loaded and closed events fire once and unavailable developer tools preserve the original exception', () => {
  const h = desktop(), c = h.context, win = c.nw.Window.get();
  let loaded = 0, closed = 0;
  win.on('loaded', () => loaded++); win.on('closed', () => closed++);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-rpgmaker/bootstrap.js'), 'utf8'), c);
  c.pmjsRpgMakerBootStarted(); c.pmjsRpgMakerBootStarted(); h.drain();
  assert.equal(loaded, 1);
  const observed = [];
  c.PMJS.compat.hit = () => { throw Error('strict unsupported capability'); };
  c.PMJS.compat.observed = (...args) => observed.push(args);
  const original = new Error('guest exception');
  assert.throws(() => { try { throw original; } catch (error) { win.showDevTools(); throw error; } }, error => error === original);
  assert.equal(observed.length, 1);
  c.PMJS.compat.observed = () => { throw Error('diagnostic failure'); };
  assert.equal(win.showDevTools(), false);
  win.close(true); win.close(true); assert.equal(closed, 1); assert.equal(h.quits, 1);
});

test('sequential desktop resize plugins use the current physical viewport', () => {
  const h = desktop(), c = h.context;
  c.__pmjsCommitLogicalSize(960, 864);
  c.resizeBy(480 - c.innerWidth, 432 - c.innerHeight);
  assert.equal(c.innerWidth, 480); assert.equal(c.innerHeight, 432);
  c.resizeBy(816 - c.innerWidth, 624 - c.innerHeight);
  assert.equal(c.nw.Window.get().width, 816); assert.equal(c.nw.Window.get().height, 624);
  assert.equal(c.nativeLogicalWidth, 960); assert.equal(c.nativeLogicalHeight, 864);
});
