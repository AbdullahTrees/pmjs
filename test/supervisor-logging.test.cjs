'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { runSupervised, openSessionLog, memorySnapshotCause, heartbeatTimeout } = require('../runner/supervisor.cjs');
const { temporaryDirectory } = require('./helpers/temp.cjs');

test('supervisor keeps worker stderr/stdout and a signal-death record on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-session-logging-'));
  try {
    const worker = path.join(dir, 'worker.cjs');
    fs.writeFileSync(worker, [
      "process.once('message', () => {",
      "  process.stdout.write('BOOT BEGAN\\n');",
      "  process.stderr.write('NATIVE DIAGNOSTIC\\n');",
      "  process.kill(process.pid, 'SIGTERM');",
      "});"
    ].join('\n'));
    const result = await runSupervised({ saveRoot: path.join(dir, 'saves') }, { worker });
    assert.equal(result.signal, 'SIGTERM');
    const folder = path.join(dir, 'logs');
    const entries = fs.readdirSync(folder);
    assert.equal(entries.length, 1);
    const content = fs.readFileSync(path.join(folder, entries[0]), 'utf8');
    assert.match(content, /BOOT BEGAN/);
    assert.match(content, /NATIVE DIAGNOSTIC/);
    assert.match(content, /session-exit code=null signal=SIGTERM/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('session file retention keeps the newest four sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-session-retention-'));
  try {
    const saveRoot = path.join(dir, 'saves');
    for (let i = 1; i <= 9; i++) {
      const log = openSessionLog({ saveRoot }, i);
      assert.ok(log);
      log.write('session-' + i + '\n');
      log.close();
    }
    const logNames = fs.readdirSync(path.join(dir, 'logs')).sort();
    assert.equal(logNames.length, 4);
    for (const number of [6, 7, 8, 9]) {
      assert.ok(logNames.some(name => name.endsWith(String(number).padStart(6, '0') + '.log')));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker killed before accepting IPC still gets a session file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-before-boot-'));
  try {
    const worker = path.join(dir, 'early.cjs');
    fs.writeFileSync(worker, [
      "require('node:fs').writeSync(2, 'BEFORE ADDON LOAD\\n');",
      "process.kill(process.pid, 'SIGKILL');"
    ].join('\n'));
    const result = await runSupervised({ saveRoot: path.join(dir, 'saves') }, { worker });
    assert.equal(result.signal, 'SIGKILL');
    const log = fs.readFileSync(path.join(dir, 'logs', fs.readdirSync(path.join(dir, 'logs'))[0]), 'utf8');
    assert.match(log, /BEFORE ADDON LOAD/);
    assert.match(log, /session-exit code=null signal=SIGKILL/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const { createOutputLimiter, readWorkerMemory } = require('../runner/supervisor.cjs');

test('session files never exceed 2 MiB and preserve startup plus latest crash evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-log-roll-'));
  try {
    const log = openSessionLog({ saveRoot: path.join(dir, 'saves') }, 1);
    log.write('EARLY STARTUP CRUMB\n');
    log.write('A'.repeat(3 * 1024 * 1024));
    log.write('FINAL CRASH CRUMB\n');
    log.close();
    assert.ok(fs.statSync(log.path).size <= 2 * 1024 * 1024);
    const contents = fs.readFileSync(log.path, 'utf8');
    assert.ok(contents.startsWith('[pmjs] session-start'));
    assert.ok(contents.includes('EARLY STARTUP CRUMB'));
    assert.ok(contents.includes('FINAL CRASH CRUMB'));
    assert.ok(contents.includes('log-tail-rolled'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('disk retention is rate limited independently from terminal forwarding', () => {
  let now = 0;
  const values = [];
  const limiter = createOutputLimiter({ write: value => values.push(String(value)) }, () => now);
  const stdout = Buffer.alloc(400 * 1024, 65);
  const stderr = Buffer.alloc(300 * 1024, 66);
  assert.equal(limiter.write('stdout', stdout).length, stdout.length);
  assert.equal(limiter.write('stderr', stderr).length, stderr.length);
  assert.equal(limiter.write('stdout', stdout).length, stdout.length);
  limiter.finish();
  assert.ok(values.some(value => value.includes('dropped_bytes=753664')));
  assert.ok(values.some(value => value.includes('stream=stderr')));
  now += 10001;
  assert.equal(limiter.write('stdout', Buffer.from('NEW WINDOW')).toString(), 'NEW WINDOW');
});

test('supervisor memory sampler bounds values and tolerates unavailable procfs fields', () => {
  const bytes = { '/proc/321/status': 'Name:\tpmjs\nVmRSS:\t10500 kB\n',
    '/proc/meminfo': 'MemAvailable: 99000 kB\n',
    '/sys/fs/cgroup/memory.max': '1073741824\n',
    '/sys/fs/cgroup/memory.current': '900000000\n' };
  const reader = { readFileSync: filename => {
    if (!(filename in bytes)) throw new Error('ENOENT');
    return bytes[filename];
  }};
  const sampled = readWorkerMemory(321, reader);
  assert.equal(sampled.rssBytes, 10500 * 1024);
  assert.equal(sampled.headroomBytes, 99000 * 1024);
  assert.ok(!('samples' in sampled));
  assert.deepEqual(readWorkerMemory(999, { readFileSync: () => { throw Error('missing'); } }), {});
});

test('memory snapshot requests cover RSS growth, pressure, and critical events', () => {
  const MiB = 1024 * 1024;
  assert.equal(memorySnapshotCause({ rssGrowthBytes: 32 * MiB }), null);
  assert.deepEqual(memorySnapshotCause({ rssGrowthBytes: 64 * MiB }),
    { reason: 'rss-growth', critical: false });
  assert.deepEqual(memorySnapshotCause({ rssGrowthBytes: 128 * MiB }),
    { reason: 'rss-growth', critical: false });
  assert.deepEqual(memorySnapshotCause({ headroomBytes: 170 * MiB, pressureTriggered: true }),
    { reason: 'memory-pressure', critical: false });
  assert.deepEqual(memorySnapshotCause({ headroomBytes: 80 * MiB, pressureTriggered: true }),
    { reason: 'critical-memory-pressure', critical: true });
  assert.deepEqual(memorySnapshotCause({ oomKillDelta: 1 }),
    { reason: 'oom-event', critical: true });
  assert.equal(memorySnapshotCause({ rssGrowthBytes: 63 * MiB }), null);
});

test('watchdog separates startup timeout from hangs after a confirmed heartbeat', () => {
  assert.equal(heartbeatTimeout({ nowMs: 45_000, startedAtMs: 0,
    lastHeartbeatAtMs: 0, hasHeartbeat: false }), null);
  assert.equal(heartbeatTimeout({ nowMs: 61_000, startedAtMs: 0,
    lastHeartbeatAtMs: 0, hasHeartbeat: false }), 'unavailable');
  assert.equal(heartbeatTimeout({ nowMs: 61_000, startedAtMs: 0,
    lastHeartbeatAtMs: 0, hasHeartbeat: false, monitorOnline: true }), 'startup');
  assert.equal(heartbeatTimeout({ nowMs: 61_000, startedAtMs: 0,
    lastHeartbeatAtMs: 0, hasHeartbeat: false, diagnosticsReady: true }), 'missing');
  assert.equal(heartbeatTimeout({ nowMs: 45_000, startedAtMs: 0,
    lastHeartbeatAtMs: 10_000, hasHeartbeat: true }), 'hang');
  assert.equal(heartbeatTimeout({ nowMs: 39_000, startedAtMs: 0,
    lastHeartbeatAtMs: 10_000, hasHeartbeat: true }), null);
});

test('supervisor requests, logs, and retains a worker memory snapshot on abnormal exit', async () => {
  const dir = temporaryDirectory('pmjs-memory-ipc-');
    const worker = path.join(dir, 'snapshot-worker.cjs');
    fs.writeFileSync(worker, [
      "const protocol = 1;",
      "process.send({ type: 'pmjs-worker-monitor-online', protocol });",
      "let started = false;",
      "process.on('message', message => {",
      "  if (!started) { started = true; process.send({ type: 'pmjs-worker-diagnostics-ready', protocol }); return; }",
      "  if (!message || message.type !== 'pmjs-memory-snapshot-request') return;",
      "  setTimeout(() => process.send({ type: 'pmjs-memory-snapshot', requestId: message.requestId,",
      "      supervisorMemory: message.supervisorMemory,",
      "      snapshot: { reason: message.reason, capturedAt: new Date().toISOString(),",
      "        context: { mapId: 5 }, native: { images: { cpuBytes: 1234 } } } },",
      "      () => process.exit(1)), 25);",
      "});"
    ].join('\n'));
    let reads = 0;
    const MiB = 1024 * 1024;
    const result = await runSupervised({ saveRoot: path.join(dir, 'saves') }, { worker,
      monitorIntervalMs: 10,
      snapshotTimeoutMs: 5,
      memoryReader: () => ({
        rssBytes: (100 + reads++ * 70) * MiB,
        anonymousRssBytes: 90 * MiB, fileRssBytes: 10 * MiB, headroomBytes: 500 * MiB }),
      oomCounter: () => 0,
      cpuReader: () => 1,
      processListReader: () => []
    });
    assert.equal(result.code, 1);
    const logPath = path.join(dir, 'logs', fs.readdirSync(path.join(dir, 'logs'))[0]);
    const content = fs.readFileSync(logPath, 'utf8');
    assert.match(content, /worker-monitor-online protocol=1/);
    assert.match(content, /worker-diagnostics-ready protocol=1/);
    assert.match(content, /memory-breakdown .*"reason":"rss-growth"/);
    assert.match(content, /memory-breakdown-timeout .*timeout_ms=5/);
    assert.match(content, /memory-breakdown .*"late":true/);
    assert.match(content, /"responseDelayMs":\d+/);
    assert.match(content, /"cpuBytes":1234/);
    assert.match(content, /last-game-memory-snapshot .*"stale":false/);
    assert.match(content, /"rssBytes":\d+/);
});

test('older workers keep OS monitoring but do not receive unsupported memory requests', async () => {
  const dir = temporaryDirectory('pmjs-old-worker-');
  const worker = path.join(dir, 'old-worker.cjs');
  fs.writeFileSync(worker, [
    "const fs = require('node:fs');",
    "process.on('message', message => {",
    "  if (message && message.type === 'pmjs-memory-snapshot-request') fs.appendFileSync(process.env.PMJS_OLD_WORKER_REQUESTS, 'request\\n');",
    "  if (message && message.saveRoot) setTimeout(() => process.exit(0), 40);",
    "});"
  ].join('\n'));
  const requests = path.join(dir, 'requests');
  const old = process.env.PMJS_OLD_WORKER_REQUESTS;
  process.env.PMJS_OLD_WORKER_REQUESTS = requests;
  try {
    const result = await runSupervised({ saveRoot: path.join(dir, 'saves') }, { worker,
      monitorIntervalMs: 5, workerHandshakeTimeoutMs: 5,
      memoryReader: (() => { let reads = 0; return () => ({
        rssBytes: (100 + reads++ * 70) * 1024 * 1024, headroomBytes: 500 * 1024 * 1024
      }); })(),
      oomCounter: () => 0, cpuReader: () => 1, processListReader: () => []
    });
    assert.equal(result.code, 0);
    const logPath = path.join(dir, 'logs', fs.readdirSync(path.join(dir, 'logs'))[0]);
    const content = fs.readFileSync(logPath, 'utf8');
    assert.match(content, /worker-monitor-unavailable reason=protocol-timeout/);
    assert.doesNotMatch(content, /memory-breakdown-timeout/);
    assert.equal(fs.existsSync(requests), false);
  } finally {
    if (old === undefined) delete process.env.PMJS_OLD_WORKER_REQUESTS;
    else process.env.PMJS_OLD_WORKER_REQUESTS = old;
  }
});

test('worker memory and OOM counters use the worker cgroup when it is nested', () => {
  const { oomKillCount, workerCgroupDirectory } = require('../runner/supervisor.cjs');
  const files = {
    '/proc/321/cgroup': '0::/user.slice/game.scope\n',
    '/sys/fs/cgroup/user.slice/game.scope/memory.current': String(900 * 1024 * 1024),
    '/sys/fs/cgroup/user.slice/game.scope/memory.max': String(1024 * 1024 * 1024),
    '/sys/fs/cgroup/user.slice/game.scope/memory.events.local': 'oom_kill 4\n',
    '/proc/321/status': 'VmRSS:\t100 kB\n',
    '/proc/meminfo': 'MemAvailable: 500000 kB\n'
  };
  const reader = { readFileSync(file) {
    if (Object.hasOwn(files, file)) return files[file];
    throw Error('ENOENT');
  }};
  const directory = workerCgroupDirectory(321, reader);
  assert.equal(directory, '/sys/fs/cgroup/user.slice/game.scope');
  assert.equal(readWorkerMemory(321, reader, directory).cgroupHeadroomBytes, 124 * 1024 * 1024);
  assert.equal(oomKillCount(reader, directory), 4);
});

test('rate-limited final stderr is preserved on abnormal exit without retaining unbounded buffers', () => {
  const output = [];
  let clock = 0;
  const limiter = createOutputLimiter({ write: value => output.push(Buffer.from(value)) }, () => clock);
  limiter.write('stderr', Buffer.alloc(128 * 1024, 'x'));
  // Small writes exercise the fixed-size circular buffer under a log flood.
  for (let i = 0; i < 25000; i++) limiter.write('stderr', Buffer.from('0123456789'));
  limiter.write('stderr', Buffer.from('\nFATAL_AFTER_STDERR_FLOOD\n'));
  limiter.finish({ abnormal: true });
  const text = Buffer.concat(output).toString();
  assert.match(text, /output-rate-limit stream=stderr/);
  const tail = text.split('final-rate-limited-stderr-tail')[1];
  assert.ok(tail.includes('FATAL_AFTER_STDERR_FLOOD'));
  assert.ok(tail.length <= 33 * 1024, 'abnormal-exit stderr tail is bounded');
  assert.ok(!text.slice(0, 128 * 1024).includes('FATAL_AFTER_STDERR_FLOOD'));
  clock += 10_001;
  assert.equal(limiter.write('stderr', Buffer.from('next')).toString(), 'next');
});

test('a normal exit does not repeat rate-limited stderr in the session log', () => {
  const output = [];
  const limiter = createOutputLimiter({ write: v => output.push(String(v)) }, () => 0);
  limiter.write('stderr', Buffer.alloc(200 * 1024, 'y'));
  limiter.finish({ abnormal: false });
  assert.equal(output.some(s => s.includes('final-rate-limited-stderr-tail')), false);
});

test('local cgroup OOM counters take precedence over hierarchical child events', () => {
  const { oomKillCount } = require('../runner/supervisor.cjs');
  const reader = { readFileSync: filename => {
    if (filename === '/proc/self/cgroup') return '0::/\n';
    if (filename === '/sys/fs/cgroup/memory.events.local') return 'oom 2\noom_kill 3\n';
    if (filename === '/sys/fs/cgroup/memory.events') return 'oom 20\noom_kill 30\n';
    throw new Error('ENOENT');
  }};
  assert.equal(oomKillCount(reader), 3);
});

test('after a disk logging failure output is no longer rate-limited at the terminal', () => {
  const bytes = Buffer.alloc(256 * 1024, 'e');
  const limiter = createOutputLimiter({ writable: () => false, write() {
    throw Error('should never be written');
  } }, () => 0);
  assert.equal(limiter.write('stderr', bytes).length, bytes.length);
  limiter.finish({ abnormal: true });
});
