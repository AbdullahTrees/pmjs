'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeEffectFixtures } = require('./effect-fixtures.cjs');
const { png } = require('./helpers/png.cjs');

function prepareSceneryFixture(root) {
  const width = 3240, height = 3240;
  const output = path.join(root, 'img/overlays/pmjs-scenery-window.png');
  const record = output + '.json';
  const encoderSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(__dirname, 'helpers/png.cjs'))).digest('hex');
  const recipe = crypto.createHash('sha256').update(JSON.stringify({
    version: 1, width, height, encoderSha256,
    pixels: ['x & 0xe0', 'y & 0xe0', '(x + y) & 0xe0', '255'],
  })).digest('hex');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  try {
    const previous = JSON.parse(fs.readFileSync(record, 'utf8'));
    if (previous.recipe === recipe && fs.existsSync(output) && previous.sha256 === hash(output)) return;
  } catch {}

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    pixels[offset] = x & 0xe0;
    pixels[offset + 1] = y & 0xe0;
    pixels[offset + 2] = (x + y) & 0xe0;
    pixels[offset + 3] = 255;
  }
  const bytes = png(width, height, pixels);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = output + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, output);
    fs.writeFileSync(record, JSON.stringify({ recipe, sha256: hash(output) }) + '\n');
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function prepare(root) {
  const source = path.join(__dirname, 'assets');
  function decode(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) decode(path.join(directory, entry.name), name);
      else if (entry.name.endsWith('.b64')) {
        const output = path.join(root, name === 'effects/Block.efkmodel.b64' ?
          'effects/Model/block.efkmodel' : name.slice(0, -4));
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, Buffer.from(fs.readFileSync(path.join(source, name), 'utf8'), 'base64'));
      }
    }
  }
  fs.mkdirSync(root, { recursive: true });
  decode(source);
  for (const name of ['testfont.ttf', 'text-shaping.ttf']) {
    fs.copyFileSync(path.join(source, name), path.join(root, name));
  }
  for (const name of ['lease.png', 'retained-fixture.png']) {
    fs.copyFileSync(path.join(root, 'fixture.png'), path.join(root, name));
  }
  writeEffectFixtures(root);
  prepareSceneryFixture(root);
  const effectRoot = path.join(root, 'effects');
  const truncatedTexture = Buffer.alloc(18);
  truncatedTexture[2] = 2; truncatedTexture[12] = 1; truncatedTexture[14] = 1; truncatedTexture[16] = 32;
  fs.writeFileSync(path.join(effectRoot, 'Truncat.tga'), truncatedTexture);
  const truncatedEffect = fs.readFileSync(path.join(effectRoot, 'InvalidTexture.efkefc'));
  const invalidTexturePath = Buffer.from('Invalid.png', 'utf16le');
  const textureOffset = truncatedEffect.indexOf(invalidTexturePath);
  if (textureOffset < 0) throw new Error('prepared InvalidTexture fixture lost its resource path');
  Buffer.from('Truncat.tga', 'utf16le').copy(truncatedEffect, textureOffset);
  fs.writeFileSync(path.join(effectRoot, 'TruncatedTexture.efkefc'), truncatedEffect);
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('usage: prepare-fixtures.cjs OUTPUT_DIRECTORY');
  prepare(path.resolve(process.argv[2]));
}
module.exports = { prepare, prepareSceneryFixture };
