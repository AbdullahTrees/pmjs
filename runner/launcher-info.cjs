'use strict';

const fs = require('node:fs');
const os = require('node:os');

function clean(value) {
  return String(value || 'unknown').replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 160) || 'unknown';
}

function deviceModel(reader = fs) {
  try {
    return clean(reader.readFileSync('/proc/device-tree/model', 'utf8'));
  } catch (_) { return 'unknown'; }
}

function availableMemoryMiB(reader, osObject) {
  try {
    const text = reader.readFileSync('/proc/meminfo', 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
    if (match) return Math.round(Number(match[1]) / 1024);
  } catch (_) {}
  return typeof osObject.freemem === 'function'
    ? Math.round(osObject.freemem() / (1024 * 1024)) : null;
}

function gpuKernelModules(reader = fs) {
  const graphicsModules = new Set([
    'amdgpu', 'i915', 'xe', 'nvidia', 'nvidia_drm', 'nouveau',
    'panfrost', 'panthor', 'lima', 'mali', 'mali_kbase', 'etnaviv',
    'msm', 'vc4', 'v3d', 'rockchipdrm'
  ]);
  try {
    return reader.readFileSync('/proc/modules', 'utf8').split(/\r?\n/)
      .map(line => line.split(/\s+/, 1)[0])
      .filter(name => graphicsModules.has(name)).join(',') || 'unknown';
  } catch (_) { return 'unknown'; }
}

function formatLauncherEnvironment({ reader = fs, osObject = os, processObject = process } = {}) {
  const cpus = osObject.cpus() || [];
  const cpu = clean(cpus.find(item => item.model)?.model);
  const ramMiB = Math.round(osObject.totalmem() / (1024 * 1024));
  const availableMiB = availableMemoryMiB(reader, osObject);
  return `[pmjs] system hardware platform=${processObject.platform} arch=${processObject.arch} ` +
    `kernel=${osObject.release()} node=${processObject.version} node_api=${processObject.versions.napi || 'unknown'} ` +
    `device=${JSON.stringify(deviceModel(reader))} cpu=${JSON.stringify(cpu)} ` +
    `cpu_threads=${cpus.length} ram_total_mib=${ramMiB} ` +
    `ram_available_mib=${availableMiB === null ? 'unknown' : availableMiB} ` +
    `gpu_kernel_modules=${gpuKernelModules(reader)}`;
}

function formatLauncherIdentity(info, buildInfoSha256) {
  const fields = ['launcher identity'];
  if (info.buildId) fields.push(`build=${info.buildId}`);
  fields.push(`source=${info.source.dirty ? 'dirty' : info.source.commit}`);
  fields.push(`build_info_sha256=${buildInfoSha256}`);
  return `[pmjs] ${fields.join(' ')}`;
}

module.exports = { availableMemoryMiB, deviceModel, formatLauncherEnvironment,
  formatLauncherIdentity, gpuKernelModules };
