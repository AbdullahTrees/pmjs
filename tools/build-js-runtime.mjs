#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareGameConfig } from './game-inspect.mjs';
import { insertExplicitAdapters, loadProfile, resolveCapabilityManifest, supportedEngines } from './build-js-composition.mjs';

const args = process.argv.slice(2);
const values = new Map();
const adapterFiles = [];
const switches = new Set(['--check', '--print-modules', '--verbose']);
const inputs = new Set(['--manifest', '--profile', '--config', '--output', '--game']);
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--adapter' && args[index + 1] && !args[index + 1].startsWith('--')) {
    adapterFiles.push(fs.realpathSync(path.resolve(args[++index])));
    continue;
  }
  if (switches.has(argument)) { values.set(argument, true); continue; }
  if (!inputs.has(argument) || values.has(argument) || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`invalid argument: ${argument}`);
  }
  values.set(argument, args[++index]);
}
const check = values.has('--check');
const printModules = values.has('--print-modules');
const verbose = values.has('--verbose');
const manifestArgument = values.get('--manifest');
const profileArgument = values.get('--profile');
const configArgument = values.get('--config');
const outputArgument = values.get('--output');
const gameArgument = values.get('--game');
if ((!profileArgument && !gameArgument) || (!outputArgument && !printModules)) {
  console.error('usage: build-js-runtime.mjs (--game DIR [--manifest FILE] | --profile NAME) [--adapter FILE ...] [--config JSON] --output FILE [--check] [--print-modules] [--verbose]');
  process.exit(2);
}
if (profileArgument && (gameArgument || manifestArgument)) {
  throw new Error('--profile cannot be combined with --game or --manifest');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = outputArgument ? path.resolve(outputArgument) : null;

function assertDisableOptimizationsShape(value, configPath) {
  if (value === undefined) return;
  const ok = Array.isArray(value) && value.every(id => typeof id === 'string' && id) &&
    new Set(value).size === value.length;
  if (!ok) {
    console.error(`error: disableOptimizations in ${configPath} must be an array of unique nonempty strings`);
    process.exit(1);
  }
}

let rawModules = [];
let buildReport = null;
let detectedRuntime = null;

if (profileArgument) {
  const { modules, baseDir } = loadProfile(root, profileArgument);
  rawModules = modules.map(module => ({ module, baseDir }));
} else {
  let manifest = {};
  let manifestPath = '<command line>';
  if (manifestArgument) {
    manifestPath = path.resolve(manifestArgument);
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  const composition = resolveCapabilityManifest({
    root,
    gameDir: gameArgument && path.resolve(process.cwd(), gameArgument),
    manifest,
    manifestPath,
  });
  rawModules = composition.modules;
  buildReport = composition.buildReport;
  detectedRuntime = composition.detectedRuntime;
}

function printBuildReport() {
  if (!buildReport) return;
  const lines = [`[pmjs-build] engine: ${buildReport.engine}`];
  if (buildReport.detected) {
    const detected = buildReport.detected;
    const versions = [detected.mvVersion ? `mv ${detected.mvVersion}` : null,
      detected.pixiVersion ? `pixi ${detected.pixiVersion}` : null]
      .filter(Boolean).join(', ');
    lines.push(`[pmjs-build] detected: ${detected.engine}${versions ? ` (${versions})` : ''}, ${detected.enabledPlugins}/${detected.pluginTotal} plugins enabled`);
  }
  lines.push(`[pmjs-build] matched adapters: ${buildReport.adapters.length}`);
  if (buildReport.adapters.length) lines.push(buildReport.adapters.map(entry => `  ${entry}`).join('\n'));
  if (buildReport.detected) {
    const unmatched = buildReport.detected.unmatchedEnabledPlugins;
    lines.push(`[pmjs-build] unmatched enabled plugins: ${unmatched.length}`);
    if (verbose && unmatched.length) lines.push(`No PMJS adapter:\n${unmatched.map(name => `  ${name}`).join('\n')}`);
  }
  const write = printModules ? console.error : console.log;
  write(lines.join('\n'));
}

rawModules = insertExplicitAdapters(rawModules, adapterFiles);

const seenModules = new Set();
for (const item of rawModules) {
  if (!item.file && (typeof item.module !== 'string' || !item.module || path.isAbsolute(item.module) ||
      item.module.split(/[\\/]/).includes('..'))) {
    throw new Error(`invalid bundle module: ${item.module}`);
  }
  const identity = item.file || fs.realpathSync(path.resolve(root, item.module));
  if (seenModules.has(identity)) {
    throw new Error(`duplicate module in profile/manifest: ${item.module}`);
  }
  seenModules.add(identity);
}

const bundleItems = [];
const runtimeEngine = detectedRuntime?.engine || (rawModules.some(item => item.module.startsWith('js/pmjs-mz/')) ? 'mz' :
  rawModules.some(item => item.module.startsWith('js/pmjs-mv/')) ? 'mv' : null);
if (runtimeEngine) bundleItems.push({ label: 'runtime-engine', inlineSource:
  `globalThis.PMJS_RUNTIME_ENGINE = ${JSON.stringify(runtimeEngine)};\n` });

if (detectedRuntime) {
  bundleItems.push({ label: 'detected-game', inlineSource:
    `globalThis.PMJS_RUNTIME_GAME = ${JSON.stringify(detectedRuntime)};\n` });
}

let parsedConfig = {};
let configLabel = 'game-config';
if (configArgument) {
  const resolvedConfig = path.resolve(process.cwd(), configArgument);
  if (!fs.existsSync(resolvedConfig)) {
    console.error(`error: config file not found: ${resolvedConfig}`);
    process.exit(1);
  }
  try { parsedConfig = JSON.parse(fs.readFileSync(resolvedConfig, 'utf8')); }
  catch (error) { throw new Error(`invalid JSON in config file ${resolvedConfig}: ${error.message}`); }
  if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) throw new Error('configuration must be an object');
  assertDisableOptimizationsShape(parsedConfig.disableOptimizations, resolvedConfig);
  configLabel = path.basename(resolvedConfig);
}
if (gameArgument) parsedConfig = prepareGameConfig(path.resolve(gameArgument), parsedConfig);
if (configArgument || Object.keys(parsedConfig).length) {
  bundleItems.push({ label: configLabel, inlineSource:
    `globalThis.PMJS_GAME_CONFIG = ${JSON.stringify(parsedConfig, null, 2)};\n` });
}
for (const item of rawModules) {
  bundleItems.push({ label: item.module, module: item.module, file: item.file, baseDir: root });
}

function buildBundle() {
  return bundleItems.map(item => {
    let source;
    if (item.inlineSource) {
      source = item.inlineSource;
    } else if (item.file) {
      source = fs.readFileSync(item.file, 'utf8');
    } else {
      const fileResolved = path.resolve(item.baseDir, item.module);
      source = fs.readFileSync(fileResolved, 'utf8');
    }
    return `// BEGIN ${item.label}\n${source.trimEnd()}\n// END ${item.label}\n`;
  }).join('\n');
}

const bundle = buildBundle();
if (printModules) {
  printBuildReport();
  console.log(JSON.stringify(rawModules.map(item => ({
    module: item.module,
    base: item.file ? 'explicit-adapter' : 'native-runtime',
  }))));
  process.exit(0);
}
if (check) {
  if (!output) {
    console.error('error: --check requires --output');
    process.exit(2);
  }
  const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  if (current !== bundle) {
    console.error(`${path.relative(root, output)} is out of date`);
    process.exitCode = 1;
  }
} else if (fs.existsSync(output) && fs.readFileSync(output, 'utf8') === bundle) {
  console.log(`unchanged ${path.relative(process.cwd(), output)}`);
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, bundle, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  console.log(`generated ${path.relative(process.cwd(), output)} from ${bundleItems.length} modules`);
  printBuildReport();
}
