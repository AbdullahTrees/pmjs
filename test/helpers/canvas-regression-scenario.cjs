/* global document, ImageData */
'use strict';

function canvasRegressionFixtures() {
  var frames = {};
  function record(name, draw, samples) {
    var canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    draw(canvas.getContext('2d'));
    var pixels = Array.from(canvas.getContext('2d').getImageData(0, 0, 8, 8).data);
    for (var i = 0; i < pixels.length; i += 4) for (var c = 0; c < 3; c++)
      pixels[i + c] = Math.floor((pixels[i + c] * pixels[i + 3] + 127) / 255);
    frames[name] = samples ? samples.reduce(function(result, point) {
      var offset = (point[1] * 8 + point[0]) * 4;
      return result.concat(pixels.slice(offset, offset + 4));
    }, []) : pixels;
  }
  [['left', -4, 0, 8, 8], ['top', 0, -4, 8, 8], ['negative', 4, 8, -8, -8],
    ['full', -4, -4, 12, 12]].forEach(function(rect) {
    record('clear/' + rect[0], function(ctx) {
      ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
      ctx.clearRect.apply(ctx, rect.slice(1));
    });
  });
  [[-1, 0, 2, 1], [0, -1, 2, 2], [2, 2, -2, -2], [-4, 0, 2, 1], [3, 0, 1, 1]].forEach(function(rect, index) {
    record('dirty/' + index, function(ctx) {
      ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
      var source = new ImageData(new Uint8ClampedArray(3 * 2 * 4), 3, 2);
      for (var i = 0; i < source.data.length; i += 4) source.data.set([240, 80, 40, 255], i);
      ctx.putImageData.apply(ctx, [source, 1, 1].concat(rect));
    });
  });
  ['source-over', 'destination-out', 'destination-in', 'copy', 'multiply'].forEach(function(operation) {
    [false, true].forEach(function(vertical) {
      record('gradient/' + operation + '/' + vertical, function(ctx) {
        ctx.fillStyle = '#2060a080'; ctx.fillRect(0, 0, 8, 8);
        var gradient = ctx.createLinearGradient(1, 1, vertical ? 1 : 5, vertical ? 5 : 1);
        gradient.addColorStop(0, '#ffffff80'); gradient.addColorStop(1, '#00000000');
        ctx.globalCompositeOperation = operation; ctx.fillStyle = gradient;
        ctx.fillRect(1, 1, 4, 4);
      });
    });
    [false, true].forEach(function(stroke) {
      record('text/' + operation + '/' + stroke, function(ctx) {
        ctx.fillStyle = '#2060a0'; ctx.fillRect(0, 0, 8, 8);
        ctx.font = '7px GameFont'; ctx.globalCompositeOperation = operation;
        ctx.fillStyle = ctx.strokeStyle = '#ffffff';
        ctx[stroke ? 'strokeText' : 'fillText']('X', 1, 6);
      });
    });
  });
  [false, true].forEach(function(smoothing) {
    ['direct', 'clip', 'reflect', 'rotate', 'composite', 'fractional-crop'].forEach(function(setting) {
      record('image/' + smoothing + '/' + setting, function(ctx) {
        var source = document.createElement('canvas'); source.width = 4; source.height = 2;
        var paint = source.getContext('2d'), data = new ImageData(new Uint8ClampedArray(4 * 2 * 4), 4, 2);
        for (var y = 0; y < 2; y++) for (var x = 0; x < 4; x++)
          data.data.set(x % 2 ? [0, 0, 255, 128] : [255, 0, 0, 255], (y * 4 + x) * 4);
        paint.putImageData(data, 0, 0); ctx.imageSmoothingEnabled = smoothing;
        if (setting === 'clip') { ctx.beginPath(); ctx.rect(0, 0, 8, 8); ctx.clip(); }
        if (setting === 'reflect') { ctx.translate(8, 0); ctx.scale(-1, 1); }
        if (setting === 'rotate') { ctx.translate(8, 0); ctx.rotate(Math.PI / 2); }
        if (setting === 'composite') ctx.globalCompositeOperation = 'copy';
        if (setting === 'fractional-crop') ctx.drawImage(source, 0.75, 0, 2.5, 2, 0, 0, 8, 4);
        else ctx.drawImage(source, 0, 0, 8, 4);
      });
    });
  });
  ['plain', 'circle', 'fractional', 'rotate', 'transform', 'reflect', 'clip', 'alpha',
    'gradient', 'clockwise-start', 'anticlockwise', 'backwards-turn'].forEach(function(setting) {
    record('ellipse/' + setting, function(ctx) {
      var start = 0, end = Math.PI * 2, anticlockwise = false;
      ctx.fillStyle = '#40a0e0';
      if (setting === 'fractional') ctx.translate(0.25, -0.125);
      if (setting === 'transform') ctx.setTransform(0.8, 0.2, -0.3, 0.9, 1, 0);
      if (setting === 'reflect') { ctx.translate(8, 0); ctx.scale(-1, 1); }
      if (setting === 'clip') { ctx.rect(1, 1, 4, 5); ctx.clip(); ctx.beginPath(); }
      if (setting === 'alpha') ctx.globalAlpha = 0.5;
      if (setting === 'gradient') {
        var gradient = ctx.createLinearGradient(1, 0, 7, 0);
        gradient.addColorStop(0, '#ff000080'); gradient.addColorStop(1, '#0000ff');
        ctx.fillStyle = gradient;
      }
      if (setting === 'clockwise-start') { start = Math.PI / 2; end += start; }
      if (setting === 'anticlockwise') { end = -Math.PI * 2; anticlockwise = true; }
      if (setting === 'backwards-turn') anticlockwise = true;
      ctx.ellipse(4, 4, 3, setting === 'circle' ? 3 : 1.75,
        setting === 'rotate' ? Math.PI / 3 : 0, start, end, anticlockwise);
      ctx.fill();
    });
  });
  ['destination-in', 'destination-out', 'copy', 'multiply'].forEach(function(operation) {
    record('ellipse/composite/' + operation, function(ctx) {
      ctx.fillStyle = '#2060a080'; ctx.fillRect(0, 0, 8, 8);
      ctx.globalCompositeOperation = operation;
      ctx.fillStyle = '#ff000080';
      ctx.ellipse(4, 4, 3, 2, 0, 0, Math.PI * 2); ctx.fill();
    });
  });
  // General paths use interior samples; their edge coverage is not antialiased.
  [false, true].forEach(function(anticlockwise) {
    record('ellipse/sector-interior/' + anticlockwise, function(ctx) {
      ctx.moveTo(4, 4); ctx.ellipse(4, 4, 3, 3, 0, 0, Math.PI / 2, anticlockwise);
      ctx.closePath(); ctx.fill();
    }, [[5, 5], [2, 2], [2, 5], [5, 2], [0, 0]]);
  });
  record('ellipse/stroke-interior', function(ctx) {
    ctx.lineWidth = 2;
    ctx.ellipse(4.5, 4.5, 3, 2, 0, 0, Math.PI * 2); ctx.stroke();
  }, [[4, 4], [0, 0], [1, 4], [7, 4]]);
  record('ellipse/clip-interior', function(ctx) {
    ctx.ellipse(4, 4, 3, 2, Math.PI / 6, 0, Math.PI * 2); ctx.clip();
    ctx.fillRect(0, 0, 8, 8);
  }, [[4, 4], [0, 0], [7, 7]]);
  return frames;
}

module.exports = { canvasRegressionFixtures };
