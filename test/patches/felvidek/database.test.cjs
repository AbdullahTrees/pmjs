'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('the shipped empty QMap index recovers its schema without masking malformed or missing data', () => {
  const queued = [], loaded = [], requests = [];
  let contents = Buffer.alloc(0), exists = true, hook;
  const context = {
    require: () => ({ existsSync: () => exists, readFileSync: () => contents }),
    DataManager: { onLoad: data => loaded.push(Array.from(data)) },
    PMJS: { methods: { wrap: value => { hook = value; } }, tasks: { enqueue: fn => queued.push(fn) } }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../patches/felvidek/database.js'), 'utf8'), context);
  context.DataManager.loadDataFile = hook.wrap((...args) => requests.push(args));
  context.DataManager.loadDataFile('$index', 'QMap.json');
  assert.equal(context.$index, null);
  assert.equal(requests.length, 0);
  queued.shift()();
  assert.deepEqual(loaded, [['2']]);
  for (const bytes of [Buffer.from('["2",true]'), Buffer.from('{')]) {
    contents = bytes; context.DataManager.loadDataFile('$index', 'QMap.json');
  }
  exists = false; context.DataManager.loadDataFile('$index', 'QMap.json');
  exists = true; contents = Buffer.alloc(0); context.DataManager.loadDataFile('$map', 'Map001.json');
  assert.equal(requests.length, 4);
  assert.equal(queued.length, 0);
});
