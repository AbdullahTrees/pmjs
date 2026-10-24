'use strict';
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const MAGIC = Buffer.from([0x50,0x4d,0x43,0x4f,0x4c,0x32,0,0]); // PMCOL2
const MAX_PIXELS = 32 * 1024 * 1024;
const PASSABLE_RGB = new Set([0xffffff, 0x00ff00, 0x0000ff]);
const CANVAS_READBACK_CHANNEL = new Uint8Array(256 * 256);
const SRGB_CHROMATICITIES = [31269, 32899, 63999, 33001, 30000, 60000, 15000, 5999];
const FELVIDEK_SRGB_PROFILE = '3f6d674174f3804eb0dabdac90ae17486e898c5063a66f861c116ea033da8301';
const CRC_TABLE = new Uint32Array(256);

for (let n = 0; n < 256; n++) {
  let crc = n;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  CRC_TABLE[n] = crc >>> 0;
}

function validChunkCrc(png, typeStart, dataLength) {
  let crc = 0xffffffff;
  const end = typeStart + 4 + dataLength;
  for (let i = typeStart; i < end; i++) crc = CRC_TABLE[(crc ^ png[i]) & 255] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0) === png.readUInt32BE(end);
}

function isSrgbChromaticities(data) {
  return data.length === 32 && SRGB_CHROMATICITIES.every((value, index) =>
    data.readUInt32BE(index * 4) === value);
}

function isFelvidekSrgbProfile(data) {
  const terminator = data.indexOf(0);
  if (terminator < 1 || terminator > 79 || data[terminator + 1] !== 0) return false;
  const name = data.subarray(0, terminator).toString('latin1');
  if (name !== 'Photoshop ICC profile') return false;
  let profile;
  try { profile = zlib.inflateSync(data.subarray(terminator + 2), { maxOutputLength: 65536 }); }
  catch { return false; }
  return crypto.createHash('sha256').update(profile).digest('hex') === FELVIDEK_SRGB_PROFILE;
}

for (let alpha = 1; alpha < 256; alpha++) {
  const reciprocal = Math.floor((255 * 16777216 + Math.floor(alpha / 2)) / alpha);
  for (let channel = 0; channel < 256; channel++) {
    const premultiplied = Math.floor((channel * alpha + 127) / 255);
    CANVAS_READBACK_CHANNEL[(alpha << 8) | channel] = Math.min(255,
      Math.floor((reciprocal * premultiplied + 8388608) / 16777216));
  }
}

function canBecomePassable(red, green, blue, alpha) {
  const row = alpha << 8;
  const roundTripped = CANVAS_READBACK_CHANNEL[row | red] << 16 |
    CANVAS_READBACK_CHANNEL[row | green] << 8 |
    CANVAS_READBACK_CHANNEL[row | blue];
  return PASSABLE_RGB.has(roundTripped);
}

function decodeCollision(png) {
  if (!Buffer.isBuffer(png) || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  let w = 0, h = 0, pos = 8, header = false, ended = false;
  let seenData = false, dataEnded = false, hasIcc = false, hasSrgb = false;
  const streams = [];
  while (pos < png.length) {
    if (pos + 12 > png.length) return null;
    const size = png.readUInt32BE(pos), type = png.toString('ascii',pos+4,pos+8);
    if (size > png.length - pos - 12) return null;
    const start = pos + 8;
    const end = pos + 12 + size;
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase() ||
        !validChunkCrc(png, pos + 4, size)) return null;
    if (type === 'IHDR') {
      if (header || pos !== 8 || size !== 13) return null;
      header = true; w = png.readUInt32BE(start); h = png.readUInt32BE(start+4);
      if (!w || !h || w*h > MAX_PIXELS || png[start+8] !== 8 || png[start+9] !== 6 ||
          png[start+10] !== 0 || png[start+11] !== 0 || png[start+12] !== 0) return null;
    } else if (type === 'IDAT') {
      if (!header || dataEnded) return null;
      seenData = true;
      streams.push(png.subarray(start,start+size));
    } else if (type === 'IEND') {
      if (!header || !seenData || size !== 0) return null;
      ended = true;
    } else {
      if (!header || seenData) dataEnded = true;
      if (!header || seenData || type === 'IHDR') return null;
      const data = png.subarray(start, start + size);
      if (type === 'PLTE') {
        if (size === 0 || size > 768 || size % 3 !== 0) return null;
      } else if (type === 'pHYs') {
        if (size !== 9 || data[8] > 1) return null;
      } else if (type === 'cHRM') {
        if (!isSrgbChromaticities(data)) return null;
      } else if (type === 'iCCP') {
        if (hasIcc || hasSrgb || !isFelvidekSrgbProfile(data)) return null;
        hasIcc = true;
      } else if (type === 'sRGB') {
        if (hasIcc || hasSrgb || size !== 1 || data[0] > 3) return null;
        hasSrgb = true;
      } else if (type === 'gAMA') {
        if (size !== 4 || data.readUInt32BE(0) !== 45455) return null;
      } else if (type === 'tEXt') {
        const separator = data.indexOf(0);
        if (separator < 1 || separator > 79) return null;
      } else if (type === 'iTXt') {
        if (data.indexOf(0) < 1) return null;
      } else {
        return null;
      }
    }
    pos = end;
    if (ended) break;
  }
  if (!header || !ended || streams.length === 0 || pos !== png.length) return null;
  const rowBytes = w*4, stride = rowBytes+1;
  let inflated;
  try { inflated = zlib.inflateSync(Buffer.concat(streams), {maxOutputLength:stride*h}); }
  catch { return null; }
  if (inflated.length !== stride*h) return null;
  const bytes=Math.ceil(w*h/8);
  const out=Buffer.alloc(16+bytes);
  MAGIC.copy(out,0);out.writeUInt32LE(w,8);out.writeUInt32LE(h,12);
  let row = Buffer.alloc(rowBytes), previous = Buffer.alloc(rowBytes);
  for (let y=0;y<h;y++) {
    const filter = inflated[y*stride];
    if (filter > 4) return null;
    for (let x=0;x<rowBytes;x++) {
      const left = x>=4 ? row[x-4] : 0, up = previous[x], ul = x>=4 ? previous[x-4] : 0;
      let predictor = 0;
      if (filter===1) predictor=left;
      else if(filter===2) predictor=up;
      else if(filter===3) predictor=(left+up)>>1;
      else if(filter===4){const p=left+up-ul, a=Math.abs(p-left),b=Math.abs(p-up),c=Math.abs(p-ul);predictor=a<=b&&a<=c?left:b<=c?up:ul;}
      row[x]=(inflated[y*stride+1+x]+predictor)&255;
    }
    for (let x=0;x<rowBytes;x+=4) {
      const alpha=row[x+3];
      if (alpha===0) continue;
      if (PASSABLE_RGB.has(row[x]<<16 | row[x+1]<<8 | row[x+2]) ||
          canBecomePassable(row[x],row[x+1],row[x+2],alpha)) return null;
      const pixel=y*w+(x>>2);
      out[16+(pixel>>3)] |= 1 << (pixel&7);
    }
    const swap=row;row=previous;previous=swap;
  }
  return out;
}
module.exports = {
  id: 'felvidek-collision', version: 3,
  discover({ files }) {
    return files.filter(name => /^img\/parallaxes\/colizia[a-z0-9_-]*\.png$/i.test(name))
      .map(source => ({ source })); // basename becomes the stable output ID
  },
  generate: decodeCollision
};
