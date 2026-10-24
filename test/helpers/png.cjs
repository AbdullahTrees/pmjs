'use strict';

const zlib = require('node:zlib');

function png(width, height, pixels, { depth = 8 } = {}) {
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(data.length);
    body.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = 6;
  const source = Buffer.from(pixels);
  const rowBytes = width * 4 * (depth / 8);
  const rows = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    source.copy(rows, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { png };
