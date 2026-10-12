// Sync mode (control/sync.js) with a fake clock: words land at spoken time + delay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionSync } from '../control/sync.js';

function rig(delay = 5) {
  let now = 100;            // AudioContext seconds
  const origin = 90;        // session clock 0 = AudioContext 90 s
  const sent = [];
  let timers = [];
  const sync = new CaptionSync({
    out: (m) => sent.push({ at: now, msg: m }),
    now: () => now,
    origin: () => origin,
    delay,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms / 1000 }; timers.push(t); return t; },
    clearTimer: (t) => { timers = timers.filter((x) => x !== t); },
  });
  const advance = (to) => {
    for (;;) {
      const next = timers.filter((t) => t.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers = timers.filter((t) => t !== next);
      now = next.at;
      next.fn();
    }
    now = to;
  };
  return { sync, sent, advance, set now(v) { now = v; }, get pending() { return timers.length; } };
}
// Words spoken at session time 8.0, 8.5, 9.0 s (AudioContext 98, 98.5, 99).
const line = (final = true, id = 1, words = ['we', 'won', 'again']) => ({
  type: 'line', line: id, final, provisional: !final, emotion: final ? 'happy' : 'neutral', confidence: final ? 0.9 : 0,
  words: words.map((word, i) => ({ word, level: 'normal', size: 1, wght: 450, wdth: 100, start: 8 + i * 0.5, end: 8.3 + i * 0.5 })),
});

test('live (delay 0): every event passes straight through', () => {
  const r = rig(0);
  r.sync.send(line(false));
  r.sync.send(line(true));
  r.sync.send({ type: 'calib', progress: 1 });
  assert.equal(r.sent.length, 3);
});

test('each word appears at the moment it was spoken plus the delay, already final', () => {
  const r = rig(5);
  r.sync.send(line(false)); // live guess: never shown
  r.sync.send(line(true));
  assert.equal(r.sent.length, 0);
  r.advance(110);
  assert.deepEqual(r.sent.map((s) => [s.at, s.msg.words.length]), [[103, 1], [103.5, 2], [104, 3]]);
  assert.ok(r.sent.every((s) => s.msg.final && s.msg.emotion === 'happy'));
});

test('a line finished after its words were due shows the late words at once, the rest on time', () => {
  const r = rig(5);
  r.now = 103.6;            // the first two words (due 103, 103.5) are already late
  r.sync.send(line(true));
  assert.deepEqual(r.sent.map((s) => s.msg.words.length), [2]);
  r.advance(105);
  assert.deepEqual(r.sent.map((s) => [s.at, s.msg.words.length]), [[103.6, 2], [104, 3]]);
});

test('a revised line replaces its pending schedule; a dropped line leaves at once', () => {
  const r = rig(5);
  r.sync.send(line(true, 1, ['we', 'one']));
  r.sync.send(line(true, 1, ['we', 'won', 'again']));     // the second-pass transcript, same line
  r.advance(110);
  assert.deepEqual(r.sent.at(-1).msg.words.map((w) => w.word), ['we', 'won', 'again']);
  assert.equal(r.sent.filter((s) => s.msg.words.length === 2).length, 1); // the old schedule never fired twice
  r.sync.send({ ...line(true, 2), words: [] });
  assert.equal(r.sent.at(-1).msg.words.length, 0);
});

test('clear drops everything still waiting', () => {
  const r = rig(5);
  r.sync.send(line(true));
  r.sync.send({ type: 'clear' });
  assert.equal(r.pending, 0);
  r.advance(110);
  assert.deepEqual(r.sent.map((s) => s.msg.type), ['clear']);
});

test('readiness: how long after a line starts it is finished, and the delay to set', () => {
  const r = rig(0);
  assert.equal(r.sync.readiness(), null);
  for (const t of [101, 101.5, 102, 102.5, 104]) { r.now = t; r.sync.send(line(true)); } // first word at 98
  const k = r.sync.readiness();
  assert.equal(k.typical, 4);
  assert.equal(k.slow, 6);
  assert.equal(k.suggest, 6.5);
});

test('default timers work when called as methods (the browser rejects a bare setTimeout called on another object)', async () => {
  const sent = [];
  // A setTimeout that, like the browser's, refuses to run with `this` other than the global object.
  const real = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, ms) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return real(fn, ms); };
  try {
    const sync = new CaptionSync({ out: (m) => sent.push(m), now: () => 100, origin: () => 88, delay: 4.05 });
    sync.send(line(true)); // first word due at 88 + 8 + 4.05 = 100.05, just after now: needs a timer
  } finally { globalThis.setTimeout = real; }
  await new Promise((r) => real(r, 120));
  assert.ok(sent.length >= 1);
});
