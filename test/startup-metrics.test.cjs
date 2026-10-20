'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { measureLauncherCheck } = require('../runner/startup-metrics.cjs');

test('launcher verification log labels its check and pass with compact hash counts', () => {
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(line);
  try {
    const stats = { hashedFiles: 0, hashedBytes: 0, reusedFiles: 0 };
    measureLauncherCheck('runtime', 'cache-lookup', () => {
      stats.hashedFiles = 123;
      stats.hashedBytes = 889469;
      stats.reusedFiles = 0;
    }, stats);
  } finally {
    console.log = original;
  }
  assert.match(lines[0], /^\[pmjs\] launcher check=runtime pass=cache-lookup duration_ms=\d+\.\d hashed_files=123 hashed_kb=869 reused_files=0$/);
  assert.doesNotMatch(lines[0], /startup stage=|\bio=|verification=/);
});
