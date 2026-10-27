'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function context() {
  const realm = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pmjs-web/canvas.js'), 'utf8'), realm);
  return new realm.CanvasContext2D({});
}

test('invalid transforms preserve current coordinates and saved state', () => {
  const c = context();
  c.setTransform(2, 0, 0, 3, 4, 5);
  c.save();
  for (const mutate of [() => c.setTransform(), () => c.setTransform({ a: 2, d: 2 }),
    () => c.translate(Infinity, 0), () => c.scale(NaN, 1), () => c.rotate(Infinity),
    () => c.transform(1, 0, 0, 1, -Infinity, 0)]) {
    mutate();
    assert.deepEqual(Array.from(c._transform), [2, 0, 0, 3, 4, 5]);
  }
  c.translate(1, 2);
  assert.deepEqual(Array.from(c._transform), [2, 0, 0, 3, 6, 11]);
  c.restore();
  assert.deepEqual(Array.from(c._transform), [2, 0, 0, 3, 4, 5]);
  c.resetTransform();
  assert.deepEqual(Array.from(c._transform), [1, 0, 0, 1, 0, 0]);
});

test('globalAlpha ignores invalid assignments and converts valid values once', () => {
  const c = context();
  c.globalAlpha = 0.5;
  c.save();
  for (const value of [NaN, Infinity, -Infinity, undefined, -1, 2]) {
    c.globalAlpha = value;
    assert.equal(c.globalAlpha, 0.5);
  }
  let conversions = 0;
  c.globalAlpha = { valueOf() { conversions++; return 0.25; } };
  assert.equal(conversions, 1);
  assert.equal(c.globalAlpha, 0.25);
  c.restore();
  assert.equal(c.globalAlpha, 0.5);
  c.globalAlpha = null;
  assert.equal(c.globalAlpha, 0);
  c.globalAlpha = '1';
  assert.equal(c.globalAlpha, 1);
  assert.throws(() => { c.globalAlpha = 1n; }, { name: 'TypeError' });
  assert.equal(c.globalAlpha, 1);
});


test('nested saved drawing state retains validated values and paint identity', () => {
  const c = context();
  const paint = { _pmjsStyle: 'linear-gradient' };
  c.fillStyle = paint;
  c.strokeStyle = 'rgba(12, 34, 56, 0.5)';
  c.font = 'italic 18pt serif';
  c.globalCompositeOperation = 'multiply';
  c.textAlign = 'right'; c.textBaseline = 'top';
  c.shadowColor = 'red'; c.shadowBlur = 3; c.shadowOffsetX = 4; c.shadowOffsetY = 5;
  c.lineCap = 'round'; c.lineJoin = 'bevel'; c.lineWidth = 2; c.miterLimit = 7;
  c.imageSmoothingEnabled = false; c.lineDashOffset = 6; c.setLineDash([2, 3]);
  const keys = ['fillStyle', 'strokeStyle', 'font', 'globalCompositeOperation', 'textAlign',
    'textBaseline', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
    'lineCap', 'lineJoin', 'lineWidth', 'miterLimit', 'imageSmoothingEnabled', 'lineDashOffset'];
  const expected = keys.map(key => c[key]);
  c.save(); c.fillStyle = 'blue'; c.font = '12px sans-serif'; c.setLineDash([]);
  c.save(); c.fillStyle = 'green'; c.restore();
  assert.equal(c.fillStyle, '#0000ff');
  c.restore();
  assert.deepEqual(keys.map(key => c[key]), expected);
  assert.equal(c.fillStyle, paint);
  assert.deepEqual(Array.from(c.getLineDash()), [2, 3]);
});
