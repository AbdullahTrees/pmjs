'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { formatLauncherEnvironment, formatLauncherIdentity } = require('../runner/launcher-info.cjs');

test('launcher environment reports compact host and hardware details', () => {
  const line = formatLauncherEnvironment({
    reader: { readFileSync: file => file === '/proc/device-tree/model'
      ? 'Example Handheld\0' : file === '/proc/meminfo'
        ? 'MemTotal: 2097152 kB\nMemAvailable: 786432 kB\n'
        : 'mali_kbase 1 0 - Live 0x0\n' },
    osObject: {
      cpus: () => [{ model: 'Example ARM CPU' }, { model: 'Example ARM CPU' }],
      totalmem: () => 2 * 1024 * 1024 * 1024,
      freemem: () => 768 * 1024 * 1024,
      release: () => '6.1.0'
    },
    processObject: { platform: 'linux', arch: 'arm64', version: 'v22.0.0', versions: { napi: '10' } }
  });
  assert.equal(line, '[pmjs] system hardware platform=linux arch=arm64 kernel=6.1.0 ' +
    'node=v22.0.0 node_api=10 device="Example Handheld" cpu="Example ARM CPU" ' +
    'cpu_threads=2 ram_total_mib=2048 ram_available_mib=768 gpu_kernel_modules=mali_kbase');
});

test('launcher environment tolerates unavailable device and CPU model information', () => {
  const line = formatLauncherEnvironment({
    reader: { readFileSync() { throw new Error('unavailable'); } },
    osObject: { cpus: () => [], totalmem: () => 1024 * 1024, release: () => 'kernel' },
    processObject: { platform: 'linux', arch: 'x64', version: 'v22.0.0', versions: {} }
  });
  assert.match(line, /node_api=unknown device="unknown" cpu="unknown" cpu_threads=0 ram_total_mib=1 ram_available_mib=unknown gpu_kernel_modules=unknown$/);
});

test('launcher identity identifies dirty or clean sources and omits absent build IDs', () => {
  const sha = 'a'.repeat(64);
  assert.equal(formatLauncherIdentity({ buildId: null, source: { dirty: true, commit: 'ignored' } }, sha),
    `[pmjs] launcher identity source=dirty build_info_sha256=${sha}`);
  assert.equal(formatLauncherIdentity({ buildId: 'build-42', source: { dirty: false, commit: 'c'.repeat(40) } }, sha),
    `[pmjs] launcher identity build=build-42 source=${'c'.repeat(40)} build_info_sha256=${sha}`);
});

test('--build-info remains an implemented, version-free launcher command', () => {
  const root = temporaryDirectory('pmjs-build-info-command-');
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({
    buildId: 'fixture-build', source: { dirty: true, commit: 'abc123' }
  }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/pmjs.mjs'),
    root, '--build-info'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'PMJS build=fixture-build source=dirty');
  assert.doesNotMatch(result.stdout, /version=/);
});
