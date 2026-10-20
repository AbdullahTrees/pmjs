'use strict';

const { performance } = require('node:perf_hooks');

function measureStartup(stage, operation, stats) {
  const started = performance.now(), before = stats && { ...stats };
  try { return operation(); }
  finally {
    const work = stats && Object.fromEntries(Object.keys(stats).map(key => [key, stats[key] - before[key]]));
    const verification = work ? ` hashed_files=${work.hashedFiles || 0}` +
      ` hashed_kb=${Math.round((work.hashedBytes || 0) / 1024)}` +
      ` reused_files=${work.reusedFiles || 0}` : '';
    console.log(`[pmjs] startup stage=${stage} duration_ms=${(performance.now() - started).toFixed(1)}${verification}`);
  }
}

function measureLauncherCheck(check, pass, operation, stats) {
  const started = performance.now(), before = stats && { ...stats };
  try { return operation(); }
  finally {
    const work = stats && Object.fromEntries(Object.keys(stats).map(key => [key, stats[key] - before[key]]));
    const verification = work ? ` hashed_files=${work.hashedFiles || 0}` +
      ` hashed_kb=${Math.round((work.hashedBytes || 0) / 1024)}` +
      ` reused_files=${work.reusedFiles || 0}` : '';
    console.log(`[pmjs] launcher check=${check} pass=${pass} ` +
      `duration_ms=${(performance.now() - started).toFixed(1)}${verification}`);
  }
}

module.exports = { measureStartup, measureLauncherCheck };
