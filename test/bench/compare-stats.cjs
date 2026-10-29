'use strict';

// Compare two stats files produced by PMJS_FRAME_STATS (runtime JSONL) or by the synthetic
// scene benchmark (test/bench/synthetic-scene.cjs --json). Prints per-phase p50 means for A
// and B, the delta and percent change, plus each side's run-to-run spread so a delta smaller
// than the noise is visible as such. For low-noise results, interleave runs (A B A B A B) and
// pass all of one side's lines as file A and all of the other's as file B.
//
// Usage: node test/bench/compare-stats.cjs a.jsonl b.jsonl [--type frame-stats|bench] [--json]

const fs = require('node:fs');

function parseArgs(argv) {
  const options = { files: [], type: null, json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--type') options.type = argv[++index];
    else if (arg === '--json') options.json = true;
    else options.files.push(arg);
  }
  if (options.files.length !== 2) throw new Error('usage: compare-stats.cjs a.jsonl b.jsonl');
  return options;
}

function readStats(file, type) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const samples = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || !entry.phases) continue;
    if (type && entry.type !== type) continue;
    samples.push(entry);
  }
  if (!samples.length) throw new Error('no stats lines in ' + file);
  return samples;
}

function phaseStats(samples) {
  const phases = new Map();
  for (const sample of samples) {
    for (const [name, values] of Object.entries(sample.phases)) {
      if (!values || typeof values.p50 !== 'number') continue;
      if (!phases.has(name)) phases.set(name, []);
      phases.get(name).push(values.p50);
    }
  }
  const result = new Map();
  for (const [name, values] of phases) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    result.set(name, { mean, min, max, spread: mean ? (max - min) / mean : 0, runs: values.length });
  }
  return result;
}

function compare(aFile, bFile, type) {
  const a = phaseStats(readStats(aFile, type));
  const b = phaseStats(readStats(bFile, type));
  const names = [...new Set([...a.keys(), ...b.keys()])];
  const rows = [];
  for (const name of names) {
    const left = a.get(name), right = b.get(name);
    if (!left || !right) { rows.push({ phase: name, a: left || null, b: right || null }); continue; }
    const delta = right.mean - left.mean;
    rows.push({ phase: name, a: left, b: right, deltaMs: round(delta),
      percent: left.mean ? round(100 * delta / left.mean) : null,
      withinNoise: Math.abs(delta) <= Math.max(left.spread, right.spread) * left.mean });
  }
  return rows;
}

function round(value) { return Math.round(value * 1000) / 1000; }

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = compare(options.files[0], options.files[1], options.type);
  if (options.json) {
    process.stdout.write(JSON.stringify({ a: options.files[0], b: options.files[1], rows }) + '\n');
    return;
  }
  console.log('phase          A p50 ms   A spread   B p50 ms   B spread   delta ms   delta %');
  for (const row of rows) {
    if (!row.a || !row.b) {
      console.log(row.phase.padEnd(14) + ' (only in ' + (row.a ? 'A' : 'B') + ')');
      continue;
    }
    console.log(row.phase.padEnd(14) +
      String(row.a.mean).padStart(10) + ' ' + (100 * row.a.spread).toFixed(1).padStart(8) + '%' +
      String(row.b.mean).padStart(11) + ' ' + (100 * row.b.spread).toFixed(1).padStart(8) + '%' +
      String(row.deltaMs).padStart(11) + ' ' + String(row.percent).padStart(9) + '%' +
      (row.withinNoise ? '  (within run noise)' : ''));
  }
}

if (require.main === module) main();

module.exports = { compare, phaseStats, readStats };
