'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const { acquireLock } = require('../runner/preparation-lifetime.cjs');
const addon = path.resolve(process.argv[2]);
const { assets } = require(addon);

if (process.argv[3] === 'child') {
  const token = assets.tryAcquirePreparationLock(process.argv[4]);
  process.send(!!token);
  if (!token) process.disconnect();
  else process.on('message', () => {
    assets.releasePreparationLock(token);
    process.disconnect();
  });
} else {
  const test = require('node:test');
  test('kernel preparation lock serializes processes and survives owner crashes', { timeout: 10000 }, async t => {
    const root = temporaryDirectory('pmjs-kernel-lock-');
    const children = new Set();
    t.after(async () => {
      await Promise.all([...children].map(async child => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
      }));
    });
    function contender() {
      const child = fork(__filename, [addon, 'child', root], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.add(child);
      child.once('exit', () => children.delete(child));
      const exited = once(child, 'exit');
      return once(child, 'message').then(([locked]) => ({ child, locked, exited }));
    }
    const owner = assets.tryAcquirePreparationLock(root);
    assert.ok(owner);
    const inode = fs.statSync(path.join(root, '.prepare.lock')).ino;
    assert.equal(assets.tryAcquirePreparationLock(root), null);
    const blocked = await Promise.all(Array.from({ length: 4 }, contender));
    assert.ok(blocked.every(result => !result.locked));
    await Promise.all(blocked.map(result => result.exited));
    await assert.rejects(acquireLock(root, () => false, () => {}, assets, 20), /wait timed out/);
    let cancelled = false;
    assert.equal(await acquireLock(root, () => cancelled, () => { cancelled = true; }, assets), null);
    assert.equal(assets.tryAcquirePreparationLock(root), null, 'timeout and cancellation preserve the owner');
    assets.releasePreparationLock(owner);
    assets.releasePreparationLock(owner);
    assert.throws(() => assets.releasePreparationLock({}), /invalid preparation lock token/);

    const racing = await Promise.all(Array.from({ length: 4 }, contender));
    assert.equal(racing.filter(result => result.locked).length, 1);
    const winner = racing.find(result => result.locked);
    winner.child.kill('SIGKILL');
    await Promise.all(racing.map(result => result.exited));
    const recovered = await acquireLock(root, () => false, () => {}, assets);
    assert.equal(typeof recovered, 'function');
    assert.equal(assets.tryAcquirePreparationLock(root), null);
    assert.equal(fs.statSync(path.join(root, '.prepare.lock')).ino, inode, 'the lock inode is never replaced');
    recovered();
    const next = assets.tryAcquirePreparationLock(root);
    assert.ok(next);
    assets.releasePreparationLock(next);
  });
}
