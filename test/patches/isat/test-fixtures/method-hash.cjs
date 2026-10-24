'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../../../patches/isat/source-qualification.js'), 'utf8');
module.exports = function methodHash(builtinRequire = require) {
  const context = { __pmjsBuiltinRequire: builtinRequire, PMJS: { phases: { on() {} } } };
  vm.runInNewContext(source, context);
  return context.PMJS.isatMethodHash;
};
