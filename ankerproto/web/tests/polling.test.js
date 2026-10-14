import test from 'node:test';
import assert from 'node:assert/strict';
import { PollLoop } from '../src/polling.js';
test('polling waits for completion and stop invalidates an in-flight loop', async () => {
  const scheduled = [];
  let finish;
  const loop = new PollLoop(() => new Promise(resolve => { finish = resolve; }), 3000,
    (callback, delay) => { scheduled.push({callback, delay}); return scheduled.length; }, () => {});
  loop.start();
  assert.equal(scheduled[0].delay, 0);
  const work = scheduled[0].callback();
  assert.equal(scheduled.length, 1);
  loop.stop();
  finish(); await work;
  assert.equal(scheduled.length, 1);
  loop.start();
  const next = scheduled[1].callback();
  finish(); await next;
  assert.equal(scheduled[2].delay, 3000);
});
