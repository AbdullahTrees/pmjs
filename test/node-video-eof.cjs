'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const native = require(path.resolve(process.argv[2]));
native.initialize({ gameRoot: path.resolve(process.argv[3]), assetRoot: '', windowTitle: 'Native failure contracts', width: 32, height: 32 });

(async () => {
  const video = await native.media.loadVideoAsync('unknown-duration.webm');
  assert.equal(video.duration, 0, 'fixture must have no duration metadata');
  let ended = false, lastFrame = -1;
  for (let tick = 0; tick < 240; tick++) {
    const time = Math.min(tick / 40, 1.1);
    lastFrame = native.media.updateVideo(video.handle, time);
    ended = native.media.videoEnded(video.handle, time);
    if (time < 1) assert.equal(ended, false, 'EOF ended before the final frame duration');
    if (ended) break;
    await delay(5);
  }
  assert.equal(ended, true, 'durationless playback never reached EOF');
  assert.equal(lastFrame, 0.75, 'EOF preceded the final frame upload');
  native.media.updateVideo(video.handle, 0);
  assert.equal(native.media.videoEnded(video.handle, 0), false, 'seek retained the old EOF');
  native.media.releaseVideo(video.handle);
  console.log('unknown-duration video presents the last frame and reaches EOF');
})().catch(error => { console.error(error); process.exitCode = 1; });
