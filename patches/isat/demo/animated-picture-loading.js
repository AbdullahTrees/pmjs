'use strict';

PMJS.isatSourcePatches.register('js/plugins/Olivia_AnimatedPictures.js', 'animated-picture load race', (src) => {
  const marker = '/* isat-port: bind callback to requested bitmap */';
  if (src.includes(marker)) return null;
  const demoBefore = `if(this[_0x530c('0x27')]){this[_0x530c('0x26')][_0x530c('0x17')](this[_0x530c('0x2b')][_0x530c('0x18')](this));}else{this['bitmap'][_0x530c('0x17')](this[_0x530c('0x35')][_0x530c('0x18')](this));}`;
  if (!src.includes(demoBefore)) return src;
  const demoAfter = `var requestedBitmap = this.bitmap; ${marker} requestedBitmap[_0x530c('0x17')](function(){ if (this.bitmap !== requestedBitmap) return; if(this[_0x530c('0x27')]) this[_0x530c('0x2b')](); else this[_0x530c('0x35')](); }.bind(this));`;
  return src.replace(demoBefore, demoAfter);
});
