'use strict';

const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

function readIo() {
  try {
    const values = Object.fromEntries(fs.readFileSync('/proc/self/io', 'utf8').trim().split('\n')
      .map(line => line.split(':').map(value => value.trim())));
    return Object.fromEntries(['rchar', 'wchar', 'read_bytes', 'write_bytes', 'syscr', 'syscw']
      .map(key => [key, Number(values[key])]));
  } catch { return null; }
}

function ioDelta(before, after = readIo()) {
  if (!before || !after) return null;
  return Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
}

function measureStartup(stage, operation, stats) {
  const started = performance.now(), io = readIo(), before = stats && { ...stats };
  try { return operation(); }
  finally {
    const work = stats && Object.fromEntries(Object.keys(stats).map(key => [key, stats[key] - before[key]]));
    console.log(`[pmjs] startup stage=${stage} duration_ms=${(performance.now() - started).toFixed(1)} ` +
      `io=${JSON.stringify(ioDelta(io))}` + (work ? ` verification=${JSON.stringify(work)}` : ''));
  }
}

module.exports = { readIo, ioDelta, measureStartup };
