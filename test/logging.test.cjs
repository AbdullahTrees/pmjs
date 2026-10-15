'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { installConsoleLogging } = require('../runner/logging.cjs');

const prefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) /;

test('console formatting preserves levels, arguments, streams and multi-line errors', () => {
  const lines = [], target = {};
  for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
    target[method] = function(text) {
      assert.equal(this, target);
      lines.push({ method, text });
    };
  }
  installConsoleLogging(target);
  const installed = target.log;
  installConsoleLogging(target);
  assert.equal(target.log, installed);
  target.log('[pmjs] count=%d %j', 3, { cached: true });
  target.info('info'); target.debug('debug'); target.warn('fallback');
  const error = new Error('plugin failed');
  target.error('[pmjs] script:', error);
  assert.match(lines[0].text, /INFO \[pmjs\] count=3 \{"cached":true\}$/);
  assert.deepEqual(lines.map(line => line.method), ['log', 'info', 'debug', 'warn', 'error']);
  assert.deepEqual(lines.map(line => prefix.exec(line.text)?.[1]), ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR']);
  assert.ok(lines[4].text.includes('Error: plugin failed'));
  const stack = lines[4].text.split('\n');
  assert.ok(stack.length > 1);
  assert.ok(stack.every(line => prefix.test(line)));
  assert.ok(stack.some(line => line.includes('logging.test.cjs:')));
  assert.equal((lines[4].text.match(/\d{4}-\d{2}-\d{2}T/g) || []).length, stack.length);
  target._pmjsRawConsole.log('[sample] {"t":1}');
  assert.equal(lines.at(-1).text, '[sample] {"t":1}');
});

test('CLI argument errors are logged once with ERROR severity and retain their stack', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../runner/cli.cjs'), '--invalid'],
    { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const lines = result.stderr.trimEnd().split('\n');
  assert.ok(lines.every(line => prefix.exec(line)?.[1] === 'ERROR'), result.stderr);
  assert.equal((result.stderr.match(/Error: invalid argument: --invalid/g) || []).length, 1);
  assert.ok(result.stderr.includes('cli.cjs:'));
});
