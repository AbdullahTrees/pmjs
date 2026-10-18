/* global document */
'use strict';
const { runModule } = require('./runtime-context.cjs');
const vm = require('node:vm');
const { createHostContext } = require('./mz-host-context.cjs');

function installBitmapFixture() {
  function Bitmap(width, height) {
    this._canvas = document.createElement('canvas');
    this._canvas.width = width; this._canvas.height = height;
    this._context = this._canvas.getContext('2d');
    this.fontSize = 24; this.fontFace = 'GameFont';
    this.fontItalic = false; this.outlineWidth = 4;
    this.outlineColor = 'rgba(0,0,0,0.5)'; this.textColor = '#ffffff';
    this.dirtyCount = 0;
  }
  Bitmap.prototype._setDirty = function() { this.dirtyCount++; };
  Bitmap.prototype._makeFontNameText = function() {
    return (this.fontItalic ? 'Italic ' : '') + this.fontSize + 'px ' + this.fontFace;
  };
  Bitmap.prototype._drawTextOutline = function(text, tx, ty, maxWidth) {
    var context = this._context;
    context.strokeStyle = this.outlineColor;
    context.lineWidth = this.outlineWidth;
    context.lineJoin = 'round';
    context.strokeText(text, tx, ty, maxWidth);
  };
  Bitmap.prototype._drawTextBody = function(text, tx, ty, maxWidth) {
    this._context.fillStyle = this.textColor;
    this._context.fillText(text, tx, ty, maxWidth);
  };
  Bitmap.prototype.drawText = function(text, x, y, maxWidth, lineHeight, align) {
    if (text !== undefined) {
      var tx = x;
      var ty = y + lineHeight - (lineHeight - this.fontSize * 0.7) / 2;
      var context = this._context;
      var alpha = context.globalAlpha;
      maxWidth = maxWidth || 0xffffffff;
      if (align === 'center') tx += maxWidth / 2;
      if (align === 'right') tx += maxWidth;
      context.save();
      context.font = this._makeFontNameText();
      context.textAlign = align;
      context.textBaseline = 'alphabetic';
      context.globalAlpha = 1;
      this._drawTextOutline(text, tx, ty, maxWidth);
      context.globalAlpha = alpha;
      this._drawTextBody(text, tx, ty, maxWidth);
      context.restore();
      this._setDirty();
    }
  };
  globalThis.Bitmap = Bitmap;
  globalThis.Sprite = function() {};
  globalThis.Graphics = function() {};
  globalThis.Input = function() {};
  globalThis.nativeBootPhase = function() {};
}

function makeBitmapTextHarness(native, enabled = true, deferActivation = false) {
  const context = createHostContext(native, { graphics: false });
  context.PMJS.config.disableOptimizations = enabled ? [] : ['bitmap.native-draw-text'];
  context.NativeHost = { ...native, runtime: { ...native.runtime, loadScript() {} } };
  vm.runInContext('(' + installBitmapFixture.toString() + ')()', context);
  for (const file of ['pmjs-core/optimizations',
    ...(deferActivation ? ['pmjs-rpgmaker/lifecycle'] : []), 'pmjs-mv/bitmap']) {
    runModule(context, 'js/' + file + '.js');
  }
  return context;
}

module.exports = { makeBitmapTextHarness };
