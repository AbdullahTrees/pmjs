'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../js/pmjs-web/canvas.js'), 'utf8');

function drawing() {
  const paints = [], pixels = new Uint8Array(64 * 64 * 4);
  const realm = vm.createContext({ NativeHost: { runtime: { env: () => '' }, canvas: {
    paintCircle(handle, paint) { paints.push(paint); },
    compositePixels(handle, left, top, width, height, data) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        pixels.set(data.subarray((y * width + x) * 4, (y * width + x + 1) * 4),
          ((top + y) * 64 + left + x) * 4);
    },
  } } });
  vm.runInContext(source, realm);
  const context = new realm.CanvasContext2D({ width: 64, height: 64,
    _ensureNativeCanvas: () => ({ handle: 1 }) });
  return { context, paints, alpha: (x, y) => pixels[(y * 64 + x) * 4 + 3] };
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);
}

test('ellipse validates arity, coercion, finite arguments and negative radii before changing paths', () => {
  const { context } = drawing();
  context.moveTo(3, 4);
  const original = JSON.stringify(context._path);
  assert.equal(context.ellipse.length, 7);
  assert.throws(() => context.ellipse(0, 0, 2, 3, 0, 0), { name: 'TypeError' });
  assert.throws(() => context.ellipse(0, 0, -1, 3, 0, 0, 1), { name: 'IndexSizeError', code: 1 });
  assert.throws(() => context.ellipse(0, 0, 1, -3, 0, 0, 1), { name: 'IndexSizeError', code: 1 });
  assert.throws(() => context.ellipse(0n, 0, 1, 3, 0, 0, 1), { name: 'TypeError' });
  assert.throws(() => context.ellipse(Symbol(), 0, 1, 3, 0, 0, 1), { name: 'TypeError' });
  for (let position = 0; position < 7; position++) for (const invalid of [NaN, Infinity, -Infinity, 1e100]) {
    const args = [0, 0, 2, 3, 0, 0, 1]; args[position] = invalid;
    context.ellipse(...args);
  }
  context.ellipse(NaN, 0, -1, 3, 0, 0, 1);
  assert.equal(JSON.stringify(context._path), original);
  context.ellipse('10', '20', '8', '4', '0', '0', String(Math.PI / 2));
  near(context._currentPathPoint[0], 10); near(context._currentPathPoint[1], 24);
});

test('ellipse connects its start point and preserves the current endpoint for subsequent lines', () => {
  const { context } = drawing();
  context.moveTo(1, 2);
  context.ellipse(20, 20, 10, 5, 0, 0, Math.PI / 2);
  context.lineTo(30, 30);
  assert.equal(context._path.length, 1);
  assert.deepEqual(Array.from(context._subpath[0]), [1, 2]);
  assert.deepEqual(Array.from(context._subpath[1]), [30, 20]);
  const endpoint = context._subpath.at(-2);
  near(endpoint[0], 20); near(endpoint[1], 25);
  assert.deepEqual(Array.from(context._subpath.at(-1)), [30, 30]);
});

test('clockwise and anticlockwise partial ellipses fill different sectors', () => {
  for (const anticlockwise of [false, true]) {
    const { context, alpha } = drawing();
    context.moveTo(24, 24);
    context.ellipse(24, 24, 16, 12, 0, 0, Math.PI / 2, anticlockwise);
    context.closePath(); context.fill();
    assert.equal(alpha(28, 28), anticlockwise ? 0 : 255);
    assert.equal(alpha(20, 20), anticlockwise ? 255 : 0);
  }
});

test('full turns in either direction include the Chromium backwards full-turn convention', () => {
  for (const [start, end, anticlockwise] of [[0, 2 * Math.PI, false], [0, -2 * Math.PI, true],
    [0, 2 * Math.PI, true], [0, -2 * Math.PI, false], [0, 8 * Math.PI, false], [0, -8 * Math.PI, true],
    [Math.PI / 2, Math.PI * 2.5, false]]) {
    const { context, paints } = drawing();
    context.ellipse(20, 20, 10, 5, 0, start, end, anticlockwise); context.fill();
    assert.equal(paints.length, 1, `${end}/${anticlockwise}`);
    near(context._currentPathPoint[0], 20 + Math.cos(start) * 10);
    near(context._currentPathPoint[1], 20 + Math.sin(start) * 5);
  }
});

test('rotated ellipse geometry is captured without altering transform or saved state', () => {
  const { context, paints } = drawing();
  context.translate(3, 4); context.scale(2, 3);
  const transform = Array.from(context._transform);
  context.save();
  context.ellipse(10, 20, 8, 4, Math.PI / 2, 0, Math.PI * 2);
  context.restore(); context.fill();
  assert.deepEqual(Array.from(context._transform), transform);
  const t = paints[0].transform;
  near(t[0], 0); near(t[1], 24); near(t[2], -8); near(t[3], 0);
  near(t[4], 23); near(t[5], 64);
  context.beginPath(); assert.equal(context._path.length, 0);
  assert.equal(context._currentPathPoint, null);
});

test('ellipse fills retain paint, alpha, compositing and clipping', () => {
  const { context, paints } = drawing();
  context.rect(2, 2, 12, 12); context.clip(); context.beginPath();
  context.globalAlpha = 0.5; context.globalCompositeOperation = 'destination-in';
  context.fillStyle = '#ff0000';
  context.ellipse(8, 8, 6, 3, 0, 0, Math.PI * 2); context.fill('evenodd');
  assert.equal(paints[0].globalAlpha, 0.5);
  assert.equal(paints[0].composite, 'destination-in');
  assert.equal(paints[0].clips.length, 1);
});

test('multiple ellipses obey nonzero winding and evenodd fill instead of the isolated oval painter', () => {
  for (const [rule, reversed, center] of [['evenodd', false, 0], ['nonzero', false, 255], ['nonzero', true, 0]]) {
    const { context, paints, alpha } = drawing();
    context.ellipse(24, 24, 16, 12, 0, 0, Math.PI * 2);
    context.moveTo(32, 24);
    context.ellipse(24, 24, 8, 6, 0, 0, reversed ? -Math.PI * 2 : Math.PI * 2, reversed);
    context.fill(rule);
    assert.equal(paints.length, 0);
    assert.equal(alpha(24, 24), center);
    assert.equal(alpha(35, 24), 255);
  }
});

test('zero radii traverse collapsed ellipse extrema; zero sweep only establishes a point', () => {
  for (const [rx, ry] of [[0, 8], [8, 0], [0, 0]]) {
    const { context, paints } = drawing();
    context.ellipse(20, 20, rx, ry, 0, 0, Math.PI * 2);
    const xs = context._subpath.map(p => p[0]), ys = context._subpath.map(p => p[1]);
    near(Math.min(...xs), 20 - rx); near(Math.max(...xs), 20 + rx);
    near(Math.min(...ys), 20 - ry); near(Math.max(...ys), 20 + ry);
    context.fill(); assert.equal(paints.length, 0);
  }
  const { context } = drawing();
  context.ellipse(20, 20, 8, 4, 0, 0, 0);
  assert.deepEqual(Array.from(context._subpath[0]), [28, 20]);
  assert.equal(context._subpath.length, 1);
});

test('singular transforms leave the path alone, while finite negative radii still throw', () => {
  const { context } = drawing();
  context.moveTo(1, 2); context.scale(0, 1);
  const original = JSON.stringify(context._path);
  context.ellipse(20, 20, 8, 4, 0, 0, Math.PI * 2);
  assert.equal(JSON.stringify(context._path), original);
  assert.throws(() => context.ellipse(20, 20, -8, 4, 0, 0, 1), { name: 'IndexSizeError' });
});

test('large finite ellipses keep path construction bounded', () => {
  const { context } = drawing();
  context.ellipse(0, 0, 1e30, 1e30, 0, 0, Math.PI * 2);
  assert.ok(context._subpath.length <= 8193);
  assert.ok(context._subpath.every(point => point.every(Number.isFinite)));
});
