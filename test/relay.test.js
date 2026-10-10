import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Recording, Relay } from '../control/relay.js';

const MIN = 60 * 1000;

test('records events with ms since the session started', () => {
  let now = 5000;
  const rec = new Recording(() => now);
  rec.add({ type: 'clear' });
  now = 5250;
  rec.add({ type: 'calib', progress: 0.5 });
  assert.deepEqual(rec.events, [{ t: 0, msg: { type: 'clear' } }, { t: 250, msg: { type: 'calib', progress: 0.5 } }]);
  rec.reset();
  assert.deepEqual(rec.events, []);
});

test('keeps only the last 10 minutes of a long stream', () => {
  let now = 0;
  const rec = new Recording(() => now);
  for (now = 0; now <= 30 * MIN; now += 1000) rec.add({ type: 'line', at: now });
  assert.equal(rec.events.at(-1).t, 30 * MIN);
  assert.equal(rec.events[0].t, 20 * MIN);
  assert.equal(rec.events.length, 601);
});

test('a short session keeps everything', () => {
  let now = 0;
  const rec = new Recording(() => now);
  for (now = 0; now <= 9 * MIN; now += 1000) rec.add({ type: 'line' });
  assert.equal(rec.events.length, 9 * 60 + 1);
});

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

// play() only needs send(); no WebSocket involved.
function player() {
  const out = [];
  return { out, play: (events, onDone) => Relay.prototype.play.call({ send: (msg) => out.push(msg.n) }, events, onDone) };
}

test('replay keeps the original spacing', () => {
  const p = player();
  let done = false;
  p.play([{ t: 0, msg: { n: 1 } }, { t: 500, msg: { n: 2 } }], () => { done = true; });
  mock.timers.tick(0);
  assert.deepEqual(p.out, [1]);
  mock.timers.tick(500);
  assert.deepEqual(p.out, [1, 2]);
  mock.timers.tick(100);
  assert.equal(done, true);
});

test('a trimmed recording replays from its first event, not from minutes of silence', () => {
  const p = player();
  p.play([{ t: 20 * MIN, msg: { n: 1 } }, { t: 20 * MIN + 300, msg: { n: 2 } }]);
  mock.timers.tick(300);
  assert.deepEqual(p.out, [1, 2]);
});

test('stopping a replay cancels what is left', () => {
  const p = player();
  const stop = p.play([{ t: 0, msg: { n: 1 } }, { t: 1000, msg: { n: 2 } }]);
  mock.timers.tick(10);
  stop();
  mock.timers.tick(2000);
  assert.deepEqual(p.out, [1]);
});
