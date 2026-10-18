'use strict';
const { createHash } = require('node:crypto');

// Rewrite accepted fingerprints for synthetic adapter unit tests.
// These fixtures do not verify production fingerprints or plugin compatibility.
function reviewedFunctionFixture(source, functions) {
  for (const [recognizer, fn] of Object.entries(functions)) {
    const body = Function.prototype.toString.call(fn)
      .replace(/^function(?:\s+[\w$]+)?\s*\(/, 'function(');
    const digest = createHash('sha256').update(body).digest('hex');
    const pattern = new RegExp('(function ' + recognizer + '\\([\\s\\S]*?)([a-f0-9]{64})');
    source = source.replace(pattern, (_, prefix) => prefix + digest);
  }
  return source;
}
module.exports = { reviewedFunctionFixture };

// The adapter runs with a synthetic accepted contract, not its production hash.
function pinSourceFingerprint(source, variable, fn) {
  const digest = createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex');
  const pattern = new RegExp('(var ' + variable + " = )(?:'[^']*'|\\[[\\s\\S]*?\\])(;)");
  if (!pattern.test(source)) throw new Error('Missing fingerprint: ' + variable);
  return source.replace(pattern, "$1'" + digest + "'$2");
}
module.exports.pinSourceFingerprint = pinSourceFingerprint;
