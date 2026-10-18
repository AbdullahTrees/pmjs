'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function selfTest(root, graphics) {
  const manifest = path.join(root, 'build-info.json');
  const info = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const architecture = { aarch64: 'arm64', x86_64: 'x64', amd64: 'x64', AMD64: 'x64' }[info.architecture];
  assert.equal(process.arch, architecture, 'package architecture');
  assert.ok(Number(process.versions.napi) >= info.nodeApi, 'Node-API compatibility');
  let verifiedFiles = 0;
  if (info.files !== undefined || info.payloadSha256 !== undefined) {
    if (info.files !== undefined) assert.ok(info.files && typeof info.files === 'object' && !Array.isArray(info.files), 'package inventory');
    const payload = [];
    function visit(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        assert.equal(entry.isSymbolicLink(), false, `package symlink: ${file}`);
        if (entry.isDirectory()) visit(file);
        else if (file !== manifest) payload.push(path.relative(root, file));
      }
    }
    visit(root);
    payload.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    if (info.files) assert.deepEqual([...payload].sort(), Object.keys(info.files).sort(), 'exact package payload');
    const checksum = crypto.createHash('sha256');
    for (const name of payload) {
      const file = path.join(root, name);
      const digest = hash(file);
      checksum.update(name + '\0' + digest + '\0' + fs.statSync(file).size + '\n');
      if (info.files) {
        const expected = info.files[name];
        assert.equal(digest, expected.sha256, `package checksum: ${name}`);
        // FAT deployments synthesize permission bits; required executables must still run.
        if (expected.mode & 0o111) fs.accessSync(file, fs.constants.X_OK);
      }
    }
    if (info.payloadSha256 !== undefined) assert.equal(checksum.digest('hex'), info.payloadSha256, 'runtime payload checksum');
    verifiedFiles = payload.length;
  }
  fs.accessSync(path.join(root, 'bin/pmjs'), fs.constants.X_OK);
  if (info.node?.bundled) fs.accessSync(path.join(root, 'bin/node'), fs.constants.X_OK);
  const native = require(path.join(root, 'lib/pmjs_native.node'));
  assert.equal(typeof native.initialize, 'function');
  assert.equal(typeof native.runtime.quit, 'function');
  let gpu = null;
  let textBackend = null;
  if (graphics) {
    const game = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-smoke-'));
    let initialized = false;
    try {
      native.initialize({ gameRoot: game, width: 32, height: 24, windowTitle: 'PMJS package verification' });
      initialized = true;
      native.beginFrame();
      native.render.quad(0, 0, 1, 1, 1, 0, 0, 1);
      native.renderFrame();
      const shot = native.canvas.captureSceneRawPremultiplied();
      assert.deepEqual(Array.from(shot.slice(0, 4)), [255, 0, 0, 255], 'rendered pixel');
      textBackend = native.canvas.glyphStats().backend;
      assert.equal(textBackend, info.skia65 === 'ON' ? 'skia65' : 'freetype', 'configured text backend');
      native.swapFrame();
      gpu = native.render.graphicsInfo();
    } finally {
      try { if (initialized) native.runtime.quit(); }
      finally { fs.rmSync(game, { recursive: true, force: true }); }
    }
  }
  return { schema: 1, packageSha256: hash(manifest), platform: process.platform, architecture: process.arch,
    kernel: os.release(), node: process.version, nodeApi: Number(process.versions.napi),
    verifiedFiles, load: true, graphics: gpu, textBackend,
    test: graphics ? 'runtime-graphics' : verifiedFiles ? 'package-load' : 'runtime-load',
    status: 'passed' };
}

if (require.main === module) {
  try { console.log(JSON.stringify(selfTest(path.resolve(process.argv[2]), process.argv.includes('--graphics')))); }
  catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
module.exports = { selfTest };
