'use strict';

// Synthetic scene benchmark for the MV scene encoder and transform preparation.
//
// Builds a game-free stage with mock PIXI nodes (the scene-encoder test harness): a visible
// tile window (15x11 tiles), 300 character sprites (60 of them animated), 6 windows with
// content sprites, a filtered layer (blur + colour matrix) and blend-mode sprites. A seeded
// PRNG drives the animation so every run is identical. Per frame it runs the real
// prepareTransforms and submitNativeScene (encode) code and reports p50/p95/max per phase and
// microseconds per visited node.
//
// This measures the encoder and preparation loops in isolation — the mock transform methods
// are no-ops, so prepare time excludes PIXI's own matrix math and real window repaints. It is
// a relative A/B tool for encoder changes; PMJS_FRAME_STATS on a real game is the ground truth
// for whole-frame costs.
//
// Usage: node test/bench/synthetic-scene.cjs [--frames N] [--warmup N] [--json FILE] [--quiet]

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { makeHarness } = require('../helpers/scene-encoder-harness.cjs');
const { percentiles } = require('../../runner/frame-stats.cjs');

function parseArgs(argv) {
  const options = { frames: 600, warmup: 60, json: null, quiet: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--frames') options.frames = Number(argv[++index]);
    else if (arg === '--warmup') options.warmup = Number(argv[++index]);
    else if (arg === '--json') options.json = argv[++index];
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error('unknown argument: ' + arg);
  }
  if (!(options.frames > 0)) throw new Error('--frames must be positive');
  return options;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function buildScene(harness) {
  const sandbox = harness.sandbox;
  const PIXI = sandbox.PIXI;
  // Mocks share one node-level and one transform-level updateTransform so the plan can share
  // entries per kind (the plan entry's method must be the node's own method identity).
  const transformProto = Object.getPrototypeOf(new PIXI.Container().transform);
  transformProto.updateTransform = function() {};
  const nodeUpdateTransform = function() {};
  PIXI.Container.prototype.updateTransform = nodeUpdateTransform;
  const containerEntry = kind => ({ method: nodeUpdateTransform,
    nativePreparation: true, equivalent: { kind } });
  const plan = new Map();
  const nodeEntries = new Map();

  function nodeOf(node, kind) {
    if (kind === 'container') node._boundsID = 0;
    if (kind === 'leaf') node._bounds = { updateID: 0 };
    nodeEntries.set(node, kind);
    plan.set(node, containerEntry(kind));
    return node;
  }
  const add = (parent, child) => { parent.addChild(child); return child; };

  const stage = nodeOf(new PIXI.Container(), 'container');
  stage.parent = { transform: {} }; // renderNativeStage replaces the stage parent while preparing

  // Visible tile window of a 40x30 map: 15x11 tile sprites. The tilemap mock carries the MV
  // fields the native preparation path reads; its paint/sort calls are no-ops (their real cost
  // is measured on the device, not here).
  const tilemap = nodeOf(new sandbox.Tilemap(), 'container');
  tilemap.origin = { x: 0, y: 0 };
  tilemap.tilePosition = { x: 0, y: 0 };
  tilemap._margin = 0;
  tilemap._tileWidth = 32;
  tilemap._tileHeight = 32;
  tilemap.animationFrame = 0;
  tilemap._needsRepaint = true;
  tilemap._updateLayerPositions = function() {};
  tilemap._paintAllTiles = function() {};
  tilemap._sortChildren = function() {};
  stage.addChild(tilemap);
  const tileTexture = harness.makeTexture(32, 32);
  const tiles = [];
  for (let row = 0; row < 11; row++) {
    for (let column = 0; column < 15; column++) {
      const tile = nodeOf(new PIXI.Sprite(tileTexture), 'leaf');
      add(tilemap, tile);
      tile.x = column * 32;
      tile.y = row * 32;
      tiles.push(tile);
    }
  }

  // 300 characters; every fifth animates (walks in place across the map).
  const characters = nodeOf(new PIXI.Container(), 'container');
  stage.addChild(characters);
  const sheets = [];
  for (let index = 0; index < 12; index++) sheets.push(harness.makeTexture(96, 128));
  const sprites = [];
  for (let index = 0; index < 300; index++) {
    const sprite = nodeOf(new PIXI.Sprite(sheets[index % sheets.length]), 'leaf');
    add(characters, sprite);
    sprite.x = (index % 20) * 48;
    sprite.y = Math.floor(index / 20) * 64;
    sprites.push(sprite);
  }

  // 6 windows, each with back/frame/contents sprites.
  const windows = nodeOf(new PIXI.Container(), 'container');
  stage.addChild(windows);
  const windowTexture = harness.makeTexture(400, 200);
  for (let index = 0; index < 6; index++) {
    const windowNode = nodeOf(new sandbox.Window(), 'Window');
    windowNode._updateCursor = function() {};
    windowNode._updateArrows = function() {};
    windowNode._updatePauseSign = function() {};
    windowNode._updateContents = function() {};
    add(windows, windowNode);
    windowNode.x = index * 20;
    windowNode.y = index * 30;
    for (let part = 0; part < 3; part++) {
      const sprite = nodeOf(new PIXI.Sprite(windowTexture), 'leaf');
      add(windowNode, sprite);
      sprite.y = part;
    }
  }

  // One filtered layer (blur + colour matrix) and blend-mode sprites.
  const filtered = nodeOf(new PIXI.Container(), 'container');
  stage.addChild(filtered);
  filtered.filters = [new PIXI.filters.BlurFilter(2, 2), new PIXI.filters.ColorMatrixFilter()];
  for (let index = 0; index < 20; index++) {
    const sprite = nodeOf(new PIXI.Sprite(sheets[index % sheets.length]), 'leaf');
    add(filtered, sprite);
    sprite.x = index * 8;
  }
  const additive = nodeOf(new PIXI.Container(), 'container');
  stage.addChild(additive);
  for (let index = 0; index < 8; index++) {
    const sprite = nodeOf(new PIXI.Sprite(windowTexture), 'leaf');
    add(additive, sprite);
    sprite.blendMode = 1;
    sprite.x = index * 48;
  }

  let visited = 0;
  const count = node => {
    visited++;
    if (nodeEntries.get(node) === 'leaf') return;
    for (const child of node.children) if (child.visible) count(child);
  };
  count(stage);

  return { stage, plan, tiles, sprites, visited };
}

function run(options) {
  const harness = makeHarness();
  const sandbox = harness.sandbox;
  // The real submit copies the packet for assertions; keep only the encode cost here.
  let submittedCount = 0;
  sandbox.NativeHost.scene.submit = (version, metadata, values, count) => { submittedCount = count; };
  const scene = buildScene(harness);
  const random = mulberry32(0x5EED);

  const prepareSamples = [];
  const encodeSamples = [];
  const records = [];
  const frames = options.warmup + options.frames;
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    // Deterministic animation: every fifth character moves; tiles and windows stay put.
    for (let index = 0; index < scene.sprites.length; index += 5) {
      const sprite = scene.sprites[index];
      sprite.x = (sprite.x + 1 + (random() < 0.5 ? 0 : 1)) % 720;
      sprite.y = (sprite.y + 0.5) % 480;
    }
    const prepareStart = performance.now();
    sandbox.PMJS.pixi4.scenePreparation.transforms(scene.plan, scene.stage);
    const encodeStart = performance.now();
    sandbox.submitNativeScene(scene.stage);
    const end = performance.now();
    if (frameIndex >= options.warmup) {
      prepareSamples.push(encodeStart - prepareStart);
      encodeSamples.push(end - encodeStart);
      records.push(submittedCount);
    }
  }

  const recordCount = records.at(-1) || 0;
  const preparePhase = percentiles(Float64Array.from(prepareSamples), prepareSamples.length);
  const encodePhase = percentiles(Float64Array.from(encodeSamples), encodeSamples.length);
  const summary = {
    type: 'bench',
    time: new Date().toISOString(),
    frames: options.frames,
    scene: { visitedNodes: scene.visited, records: recordCount },
    phases: { prepare: preparePhase, encode: encodePhase },
    usPerNode: {
      prepare: +(preparePhase.p50 * 1000 / scene.visited).toFixed(3),
      encode: +(encodePhase.p50 * 1000 / Math.max(1, recordCount)).toFixed(3)
    },
    compatHits: harness.compatHits.length
  };
  return { summary };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { summary } = run(options);
  if (!options.quiet) {
    console.log('synthetic scene: ' + summary.scene.visitedNodes + ' nodes, ' +
      summary.scene.records + ' records, ' + summary.frames + ' frames');
    console.log('  prepare p50 ' + summary.phases.prepare.p50 + ' ms (' +
      summary.usPerNode.prepare + ' us/node)  p95 ' + summary.phases.prepare.p95 +
      ' ms  max ' + summary.phases.prepare.max + ' ms');
    console.log('  encode  p50 ' + summary.phases.encode.p50 + ' ms (' +
      summary.usPerNode.encode + ' us/record) p95 ' + summary.phases.encode.p95 +
      ' ms  max ' + summary.phases.encode.max + ' ms');
    if (summary.compatHits) console.log('  compat hits: ' + summary.compatHits);
  }
  const line = JSON.stringify(summary) + '\n';
  if (options.json) fs.appendFileSync(options.json, line);
  else if (options.quiet) process.stdout.write(line);
}

if (require.main === module) main();

module.exports = { buildScene, run, mulberry32 };
