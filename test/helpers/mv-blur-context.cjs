'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { blur } = require('./mv-reviewed-methods.cjs');
const { createHostContext } = require('./mz-host-context.cjs');

function createMvBlurContext(native, { stockBlur, disableOptimizations = [] } = {}) {
  const context = createHostContext(native, { graphics: false });
  context.PMJS_GAME_CONFIG = { disableOptimizations };
  const root = path.resolve(__dirname, '../..');
  for (const module of ['pmjs-core/config', 'pmjs-core/optimizations', 'pmjs-rpgmaker/lifecycle']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', module + '.js'), 'utf8'), context);
  }
  vm.runInContext(`
    function Bitmap(width, height) {
      this.width = width; this.height = height;
      this._canvas = document.createElement('canvas');
      this._canvas.width = width; this._canvas.height = height;
      this._context = this._canvas.getContext('2d');
      this.dirtyCalls = 0; this.stockCalls = 0;
    }
    Bitmap.prototype._setDirty = function() { this.dirtyCalls++; };
    Bitmap.prototype.fillRect = function(x, y, width, height, color) {
      this._context.save();
      this._context.fillStyle = color;
      this._context.fillRect(x, y, width, height);
      this._context.restore();
      this._setDirty();
    };
    Bitmap.prototype.fillAll = function(color) { this.fillRect(0, 0, this.width, this.height, color); };
    Bitmap.prototype._makeFontNameText = function() { return '24px GameFont'; };
    Bitmap.prototype.measureTextWidth = function(text) {
      var context = this._context;
      context.save();
      context.font = this._makeFontNameText();
      var width = context.measureText(text).width;
      context.restore();
      return width;
    };
    Bitmap.prototype.blur = ${stockBlur || blur.toString()};
    function Sprite() {}
    function Graphics() {}
    function Input() {}
    function nativeBootPhase() {}
  `, context);
  const loadScript = native.runtime.loadScript;
  native.runtime.loadScript = () => {};
  try {
    vm.runInContext(fs.readFileSync(path.join(root, 'js/pmjs-mv/bitmap.js'), 'utf8'), context);
  } finally {
    native.runtime.loadScript = loadScript;
  }
  return context;
}

module.exports = { createMvBlurContext };
