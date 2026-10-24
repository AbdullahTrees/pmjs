'use strict';

PMJS.isatSourcePatches.register('js/plugins/Olivia_AnimatedPictures.js', 'animated-picture load race', (src) => {
  const marker = '/* isat-port: bind callback to requested bitmap */';
  if (src.includes(marker)) return null;

  const before =
    '  if (this._isAnimatedPicture) {\n' +
    '    this.bitmap.addLoadListener(this.updateAnimatedPictureFrame.bind(this));\n' +
    '  } else {\n' +
    '    this.bitmap.addLoadListener(this.resetFrame.bind(this));\n' +
    '  }';
  if (!src.includes(before)) return src;
  const after =
    `  var requestedBitmap = this.bitmap; ${marker}\n` +
    '  requestedBitmap.addLoadListener(function () {\n' +
    '    if (this.bitmap !== requestedBitmap) return;\n' +
    '    if (this._isAnimatedPicture) this.updateAnimatedPictureFrame();\n' +
    '    else this.resetFrame();\n' +
    '  }.bind(this));';
  return src.replace(before, after);
});
