#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { detectEngine, preparationInputs } from './game-inspect.mjs';
import { createBundle, gameDeclarations, readBundle } from './game-bundle.mjs';

const root = path.resolve(process.argv[2]);
const share = path.join(root, 'share/pmjs');
const info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8'));
const args = process.argv.slice(3);
const first = args.shift();
const help = `PMJS ${info.version} (${info.source.commit.slice(0, 12)}${info.source.dirty ? ', modified' : ''})
Usage:
  pmjs GAME [--config FILE] [--manifest FILE] [--adapter FILE ...]
  pmjs bundle GAME --output DIR [--include-assets | --no-index]
      [--config FILE] [--manifest FILE] [--adapter FILE ...]
  pmjs BUNDLE [--game DIR]
  pmjs package BUNDLE --runtime DIR --output ZIP
  pmjs run --game DIR [--state DIR] [--save-root DIR] [--asset-cache-root DIR]
  pmjs prepare --game DIR [--state DIR] [--config FILE] [--manifest FILE]
  pmjs self-test [--graphics]
  pmjs --version
Game paths may contain a www/ directory. Prepared files use the user cache;
saves use the user data directory. Game JavaScript runs with Node capabilities.
Only run games you trust.`;

function invoke(file, arguments_) {
  const result = spawnSync(process.execPath, [file, ...arguments_], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`operation failed (${result.signal || result.status})`);
}

function parse(values, names, requireGame = true) {
  const result = { adapters: [] };
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!names.includes(key) || (key !== '--adapter' && result[key]) ||
        !values[index + 1] || values[index + 1].startsWith('--')) {
      throw new Error(`invalid argument: ${key}`);
    }
    const value = path.resolve(values[index + 1]);
    if (key === '--adapter') result.adapters.push(value);
    else result[key] = value;
  }
  if (requireGame && !result['--game']) throw new Error('--game is required');
  return result;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function gameDirectory(location) {
  const directory = fs.realpathSync(location);
  if (!fs.statSync(directory).isDirectory()) throw new Error('game must be a directory');
  if (detectEngine(directory).engine !== 'unknown') return directory;
  const web = path.join(directory, 'www');
  if (fs.existsSync(web) && detectEngine(web).engine !== 'unknown') return fs.realpathSync(web);
  throw new Error(`no RPG Maker MV/MZ game found in ${directory}`);
}

function runtimeIdentity() {
  const digest = crypto.createHash('sha256');
  for (const folder of ['js', 'profiles']) {
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) {
          digest.update(path.relative(share, file));
          digest.update(hash(file));
        }
      }
    };
    visit(path.join(share, folder));
  }
  for (const name of ['build-js-runtime.mjs', 'game-inspect.mjs']) {
    digest.update(name);
    digest.update(hash(path.join(share, 'tools', name)));
  }
  return digest.digest('hex');
}

function matches(record, context) {
  try {
    return record.schema === 2 && record.game === context.game &&
      record.packageSha256 === context.packageSha256 && record.runtimeIdentity === context.runtimeIdentity &&
      record.config === context.config && record.manifest === context.manifest &&
      record.bundleBootstrapSha256 === context.bundleBootstrapSha256 &&
      JSON.stringify(record.adapters) === JSON.stringify(context.adapters) &&
      /^bootstrap-[a-f0-9]{64}\.js$/.test(record.bootstrap) &&
      hash(path.join(context.state, record.bootstrap)) === record.bootstrapSha256 &&
      JSON.stringify(record.inputs) === JSON.stringify(context.inputs);
  } catch { return false; }
}

function prepare(context) {
  fs.mkdirSync(context.state, { recursive: true });
  const temporary = path.join(context.state, `bootstrap-${process.pid}.tmp`);
  const buildArgs = ['--game', context.game, '--output', temporary];
  if (context.config) buildArgs.push('--config', context.config);
  if (context.manifest) buildArgs.push('--manifest', context.manifest);
  for (const adapter of context.adapters) buildArgs.push('--adapter', adapter);
  try {
    if (context.bundleBootstrap && context.bundleBootstrapCurrent &&
        context.bundleRuntimeIdentity === context.runtimeIdentity) {
      fs.copyFileSync(context.bundleBootstrap, temporary);
    } else {
      invoke(path.join(share, 'tools/build-js-runtime.mjs'), buildArgs);
    }
    if (JSON.stringify(context.inputs) !== JSON.stringify(preparationInputs(context.game,
      context.config, context.manifest, context.adapters)) ||
      context.runtimeIdentity !== runtimeIdentity()) {
      throw new Error('preparation inputs changed during generation; retry');
    }
    const bootstrap = `bootstrap-${hash(temporary)}.js`;
    const target = path.join(context.state, bootstrap);
    fs.renameSync(temporary, target);
    const record = { schema: 2, game: context.game, packageSha256: context.packageSha256,
      runtimeIdentity: context.runtimeIdentity, config: context.config, manifest: context.manifest,
      adapters: context.adapters, inputs: context.inputs, bootstrap, bootstrapSha256: hash(target),
      bundleBootstrapSha256: context.bundleBootstrapSha256 };
    const next = path.join(context.state, `prepared.${process.pid}.tmp`);
    try {
      fs.writeFileSync(next, JSON.stringify(record, null, 2) + '\n');
      fs.renameSync(next, path.join(context.state, 'prepared.json'));
    } finally { fs.rmSync(next, { force: true }); }
    return record;
  } finally { fs.rmSync(temporary, { force: true }); }
}

async function main() {
  if (first === '--version') { console.log(help.split('\n')[0]); return; }
  if (first === '--help' || first === 'help') { console.log(help); return; }
  if (first === 'self-test') {
    if (args.some(value => value !== '--graphics') || args.length > 1) throw new Error('invalid self-test arguments');
    invoke(path.join(share, 'tools/package-self-test.cjs'), [root, ...args]);
    return;
  }
  if (first === 'bundle') {
    const gameArgument = args.shift();
    if (!gameArgument || gameArgument.startsWith('--')) throw new Error('bundle requires a game directory');
    const includeAssets = args.includes('--include-assets');
    const index = !args.includes('--no-index');
    if (args.filter(value => value === '--include-assets').length > 1 ||
        args.filter(value => value === '--no-index').length > 1) throw new Error('duplicate bundle option');
    const options = parse(args.filter(value => value !== '--include-assets' && value !== '--no-index'),
      ['--output', '--config', '--manifest', '--adapter'], false);
    if (!options['--output']) throw new Error('--output is required');
    const game = gameDirectory(gameArgument);
    if (includeAssets) console.warn('[pmjs] Generated pages can contain game artwork. Share this bundle only when allowed.');
    await createBundle({ root, share, game, output: options['--output'], config: options['--config'],
      manifest: options['--manifest'], adapters: options.adapters, runtimeIdentity: runtimeIdentity(),
      index, includeAssets });
    console.log(`Bundle created: ${options['--output']}`);
    return;
  }
  if (first === 'package') {
    const bundleArgument = args.shift();
    if (!bundleArgument || bundleArgument.startsWith('--')) throw new Error('package requires a bundle directory');
    const options = parse(args, ['--runtime', '--output'], false);
    if (!options['--runtime'] || !options['--output']) throw new Error('package requires --runtime and --output');
    const bundle = readBundle(bundleArgument);
    const result = spawnSync('python3', [path.join(share, 'tools/portmaster.py'),
      '--stage', options['--runtime'], '--bundle', bundle.root, '--output', options['--output']],
    { stdio: 'inherit', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`packaging failed (${result.signal || result.status})`);
    return;
  }
  let command = first;
  let options;
  let bundle = null;
  if (first === 'prepare' || first === 'run') {
    options = parse(args, ['--game', '--state', '--save-root', '--asset-cache-root', '--config', '--manifest', '--adapter']);
  } else if (!first || first.startsWith('--')) {
    if (first) throw new Error(`unknown command: ${first}`);
    if (fs.existsSync(path.join(process.cwd(), 'pmjs.json'))) bundle = readBundle(process.cwd());
    else {
      try { gameDirectory(process.cwd()); } catch { console.log(help); return; }
    }
    command = 'run';
    options = { '--game': bundle ? path.join(bundle.root, bundle.descriptor.game) : process.cwd(), adapters: [] };
  } else {
    command = 'run';
    options = parse(args, ['--state', '--save-root', '--asset-cache-root', '--game', '--config', '--manifest', '--adapter'], false);
    if (fs.existsSync(path.join(path.resolve(first), 'pmjs.json'))) bundle = readBundle(first);
    if (!bundle || !options['--game']) options['--game'] = first;
  }
  if (bundle) {
    options['--game'] = options['--game'] === bundle.root ?
      path.join(bundle.root, bundle.descriptor.game) : options['--game'];
    options['--config'] = bundle.config;
    options['--manifest'] = bundle.manifest;
    options.adapters = bundle.adapters;
  }
  const game = gameDirectory(options['--game']);
  const id = crypto.createHash('sha256').update(game).digest('hex').slice(0, 24);
  const state = options['--state'] || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'pmjs', id);
  const prepared = path.join(state, 'prepared.json');
  let previous;
  try { previous = JSON.parse(fs.readFileSync(prepared, 'utf8')); } catch { previous = null; }
  const config = options['--config'] || (command === 'run' && previous?.game === game ? previous.config : null);
  const manifest = options['--manifest'] || (command === 'run' && previous?.game === game ? previous.manifest : null);
  const adapters = options.adapters.length ? options.adapters :
    (command === 'run' && previous?.game === game && Array.isArray(previous.adapters) ? previous.adapters : []);
  const context = { game, state, packageSha256: hash(path.join(root, 'build-info.json')),
    runtimeIdentity: runtimeIdentity(), config, manifest, adapters,
    inputs: preparationInputs(game, config, manifest, adapters) };
  if (bundle) {
    context.bundleBootstrap = path.join(bundle.root, bundle.descriptor.bootstrap);
    context.bundleBootstrapSha256 = bundle.descriptor.bootstrapSha256;
    context.bundleRuntimeIdentity = bundle.descriptor.runtimeIdentity;
    context.bundleBootstrapCurrent = bundle.bootstrapCurrent &&
      JSON.stringify(bundle.descriptor.bootstrapGameInputs) === JSON.stringify(gameDeclarations(game));
  }
  const record = command === 'prepare' || !previous || !matches(previous, context) ? prepare(context) : previous;
  if (command === 'prepare') { console.log(`Prepared ${game}`); return; }
  const saveRoot = options['--save-root'] || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'pmjs', id, 'saves');
  const { run } = await import('../runner/index.cjs');
  console.log(`[pmjs] build=${info.source.commit} package=${record.packageSha256}`);
  await run({ addon: path.join(root, 'lib/pmjs_native.node'), gameRoot: game,
    bootstrap: path.join(state, record.bootstrap), saveRoot, config: record.config || undefined,
    assetIndex: bundle?.assetIndex || undefined, assetCacheRoot: options['--asset-cache-root'] });
}

main().catch(error => { console.error(`[pmjs] ${error.stack || error}`); process.exitCode = 1; });
