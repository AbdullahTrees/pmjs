'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { temporaryDirectory } = require('./helpers/temp.cjs');

const inspection = import(pathToFileURL(path.resolve(__dirname, '../tools/game-inspect.mjs')).href);

function game(directory) {
  const js = path.join(directory, 'js');
  fs.mkdirSync(js, { recursive: true });
  fs.writeFileSync(path.join(js, 'rpg_core.js'), 'Utils.RPGMAKER_VERSION = "1.6.2";');
  fs.writeFileSync(path.join(js, 'rpg_managers.js'), '');
}

test('game directory resolution handles ordinary and PortMaster data layouts', async t => {
  const { resolveGameDirectory } = await inspection;
  const root = temporaryDirectory('pmjs-game-layout-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'gamedata');
  fs.mkdirSync(data);
  assert.throws(() => resolveGameDirectory(data), /no RPG Maker MV\/MZ game/);
  const nested = path.join(data, 'Game With Spaces', 'www');
  game(nested);
  assert.equal(resolveGameDirectory(data), nested);
  assert.equal(resolveGameDirectory(nested), nested);

  const second = path.join(data, 'Second Game', 'www');
  game(second);
  assert.throws(() => resolveGameDirectory(data), /Multiple games found/);

  const web = path.join(data, 'www');
  game(web);
  assert.equal(resolveGameDirectory(data), web);

  game(data);
  assert.equal(resolveGameDirectory(data), data);
});

test('nested MZ game folders without www resolve and reject mixed-layout ambiguity', async t => {
  const { resolveGameDirectory } = await inspection;
  const root = temporaryDirectory('pmjs-game-layout-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'Game With Spaces');
  fs.mkdirSync(path.join(nested, 'js'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'js/rmmz_core.js'), 'Utils.RPGMAKER_VERSION = "1.10.0";');
  assert.equal(resolveGameDirectory(root), nested);

  game(path.join(root, 'Second Game', 'www'));
  assert.throws(() => resolveGameDirectory(root), /Multiple games found/);
});
