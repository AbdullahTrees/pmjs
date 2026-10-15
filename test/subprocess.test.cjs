'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { createSubprocesses } = require('../runner/subprocess.cjs');

function subprocesses() {
  const queue = [], root = temporaryDirectory('subprocess-'), opened = [];
  let stopped = false;
  const service = createSubprocesses({
    tasks: () => ({ enqueue(callback) { if (!stopped) queue.push(callback); } }),
    resolveDirectory(virtual) { assert.equal(virtual, '/game'); return root; },
    openExternal(url) { opened.push(url); return true; }
  });
  return { ...service, root, opened,
    drain() { while (queue.length) queue.shift()(); },
    terminate() { stopped = true; queue.length = 0; service.stop(); } };
}

test('subprocess callbacks preserve output, errors, cwd and argument boundaries through dispatcher', async () => {
  const root = temporaryDirectory('subprocess-');
  const h = createSubprocesses({ tasks: () => ({ enqueue: callback => setImmediate(callback) }),
    resolveDirectory(virtual) { assert.equal(virtual, '/game'); return root; }, openExternal() {} });
  let child, synchronous = true;
  const completion = new Promise(resolve => {
    child = h.api.execFile(process.execPath,
      ['-e', 'process.stdout.write(process.cwd());process.stderr.write("warning");process.exitCode=7;'],
      { cwd: '/game' }, (error, stdout, stderr) => {
        assert.equal(synchronous, false);
        resolve({ error, stdout, stderr });
      });
    child.on('error', error => assert.fail(error));
  });
  synchronous = false;
  const result = await completion;
  assert.equal(result.error.code, 7);
  assert.equal(result.stdout, root);
  assert.equal(result.stderr, 'warning');
  h.stop();
});

test('verified platform URL commands use the host browser and terminated callbacks are discarded', () => {
  const h = subprocesses();
  const results = [];
  for (const command of ['open "https://example.com/a"', 'rundll32 url.dll,FileProtocolHandler https://example.com/b']) {
    h.api.exec(command, (error, stdout, stderr) => results.push([error, stdout, stderr]));
  }
  assert.equal(results.length, 0);
  h.drain();
  assert.deepEqual(results, [[null, '', ''], [null, '', '']]);
  assert.deepEqual(h.opened, ['https://example.com/a', 'https://example.com/b']);
  h.api.exec('open https://example.com/terminated', () => assert.fail('callback after shutdown'));
  h.terminate(); h.drain();
  assert.equal(h.opened.length, 2);
});

test('session shutdown settles owned subprocesses and rejects later launches', async () => {
  const root = temporaryDirectory('subprocess-stop-');
  const service = createSubprocesses({ tasks: () => ({ enqueue: callback => setImmediate(callback) }),
    resolveDirectory: () => root, openExternal: () => true });
  const child = service.api.spawn(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},60000);']);
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  await service.stop();
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  assert.throws(() => service.api.spawn(process.execPath, []), { code: 'ERR_RUNTIME_STOPPED' });
  assert.throws(() => service.api.exec('open https://example.com/after-stop'), { code: 'ERR_RUNTIME_STOPPED' });
});
