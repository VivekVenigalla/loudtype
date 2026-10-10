// Prosody with synthetic frames: what the worklet would report, ~30 per second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prosody, THRESHOLDS, CALIBRATE_WORDS } from '../control/prosody.js';
import { LEVELS } from '../control/caption.js';

const FRAME = 0.033;
const ROOM = -60;   // dBFS between words
const NORMAL = -30; // this speaker's normal level
const VOICED = 0.7, UNVOICED = 0.1;

// A speaker: room tone, then words separated by short pauses.
function speaker() {
  const p = new Prosody();
  let t = 0;
  const frames = (dur, db, voicing) => {
    for (const end = t + dur - 1e-9; t < end;) { t += FRAME; p.push(t, db, voicing); }
  };
  const span = (dur, db, voicing) => { frames(0.2, ROOM, 0.05); const start = t; frames(dur, db, voicing); return [start, t]; };
  const say = (text, { db = NORMAL, voicing = VOICED, dur = 0.3 } = {}) => p.styleWord(text, ...span(dur, db, voicing));
  const calibrate = () => { for (let i = 0; i < CALIBRATE_WORDS; i++) say('hello'); };
  frames(2, ROOM, 0.05);
  return { p, say, span, calibrate, frames, now: () => t };
}

test('everything is normal until calibrated', () => {
  const { p, say } = speaker();
  assert.equal(p.calibrated, false);
  assert.equal(say('wow', { db: NORMAL + 15 }).level, 'normal');
});

test('learns the normal level from the first voiced words', () => {
  const { p, say } = speaker();
  for (let i = 0; i < CALIBRATE_WORDS - 1; i++) say('hello');
  assert.equal(p.calibrated, false);
  assert.ok(Math.abs(p.calibration - (CALIBRATE_WORDS - 1) / CALIBRATE_WORDS) < 1e-9);
  say('hello');
  assert.equal(p.calibrated, true);
  assert.ok(Math.abs(p.ref - NORMAL) < 0.01);
});

test('an early whisper does not count toward calibration', () => {
  const { p, say } = speaker();
  say('shh', { voicing: UNVOICED, db: NORMAL - 12 });
  assert.equal(p.calibration, 0);
});

test('levels follow fixed dB steps from the speaker\'s normal', () => {
  const { say, calibrate } = speaker();
  calibrate();
  const cases = [
    [0, 'normal'], [THRESHOLDS.loud + 1, 'loud'], [THRESHOLDS.shout + 2, 'shout'],
    [THRESHOLDS.soft - 1, 'soft'], [THRESHOLDS.whisper - 2, 'whisper'], [THRESHOLDS.loud - 1, 'normal'],
  ];
  for (const [delta, want] of cases) assert.equal(say('word', { db: NORMAL + delta }).level, want, `${delta} dB`);
});

test('a word carries the size and weight of its level', () => {
  const { say, calibrate } = speaker();
  calibrate();
  const s = say('WON', { db: NORMAL + 12 });
  assert.equal(s.size, LEVELS.shout.size);
  assert.equal(s.wght, LEVELS.shout.wght);
});

test('an unvoiced word is a whisper even at normal loudness', () => {
  const { say, calibrate } = speaker();
  calibrate();
  assert.equal(say('secret', { voicing: UNVOICED }).level, 'whisper');
  // ...but not when it's clearly loud (a breathy shout is still a shout).
  assert.equal(say('HEY', { voicing: UNVOICED, db: NORMAL + 6 }).level, 'loud');
});

test('normal words slowly track the speaker; loud words do not move it', () => {
  const { p, say, calibrate } = speaker();
  calibrate();
  say('word', { db: NORMAL + 2 });
  assert.ok(p.ref > NORMAL && p.ref < NORMAL + 0.2);
  const ref = p.ref;
  say('WOW', { db: NORMAL + 12 });
  assert.equal(p.ref, ref);
});

test('a held word stretches wide; a normal-paced word does not', () => {
  const { say, calibrate } = speaker();
  calibrate(); // also learns the speaker's pace: 'hello' in 0.3 s
  assert.equal(say('hello').wdth, 100);
  assert.equal(say('no', { dur: 1.2 }).wdth, 151);
  const mid = say('hello', { dur: 0.6 }).wdth;
  assert.ok(mid > 100 && mid < 151, `wdth ${mid}`);
});

test('recalibrate forgets the last speaker', () => {
  const { p, say, calibrate } = speaker();
  calibrate();
  p.recalibrate();
  assert.equal(p.calibrated, false);
  assert.equal(p.calibration, 0);
  assert.equal(say('wow', { db: NORMAL + 15 }).level, 'normal');
});

test('styleLive splits recent audio between new words', () => {
  const { p, span, calibrate } = speaker();
  calibrate();
  const [a] = span(0.3, NORMAL - 12, UNVOICED);
  const [, b] = span(0.3, NORMAL + 12, VOICED);
  const live = p.styleLive(a, b, 2);
  assert.deepEqual(live.map((w) => w.level), ['whisper', 'shout']);
  assert.ok(live.every((w) => w.wdth === 100));
});

test('liveDelta and liveLevel describe the newest frame', () => {
  const { p, calibrate, frames } = speaker();
  assert.equal(p.liveDelta(), null); // uncalibrated
  calibrate();
  frames(0.1, NORMAL + 6, VOICED);
  assert.ok(Math.abs(p.liveDelta() - 6) < 0.01);
  assert.ok(p.liveLevel() > 0.5);
  frames(0.1, ROOM, 0.05);
  assert.equal(p.liveDelta(), null); // silence
  assert.equal(p.liveLevel(), 0);
});

// Scribe's timestamps can land a word on a pause (timing drift, a word the
// recognizer guessed). There's no audio to measure, so it stays normal and
// must not teach the model anything.
test('a word whose timing lands in silence is normal, not a whisper', () => {
  const { p, say, calibrate } = speaker();
  calibrate();
  const ref = p.ref;
  assert.equal(say('the', { db: ROOM, voicing: 0.05 }).level, 'normal');
  assert.equal(p.ref, ref);
});

test('a very quiet whisper below the speech gate is still a whisper', () => {
  const { say, calibrate } = speaker();
  calibrate();
  // 8 dB over the room: under the +10 dB speech gate, but clearly not silence.
  assert.equal(say('psst', { db: ROOM + 8, voicing: UNVOICED }).level, 'whisper');
});

test('silence during calibration does not count as a normal word', () => {
  const { p, say } = speaker();
  say('um', { db: ROOM, voicing: 0.6 }); // hum-like room tone that looks voiced
  assert.equal(p.calibration, 0);
});

test('keeps the recent words\' measurements for the mic report', () => {
  const { p, say, calibrate } = speaker();
  calibrate();
  say('loud', { db: NORMAL + 12 });
  say('the', { db: ROOM, voicing: 0.05 });
  const [shout, pause] = p.history.slice(-2);
  assert.equal(shout.word, 'loud');
  assert.equal(shout.level, 'shout');
  assert.ok(Math.abs(shout.delta - 12) < 0.01);
  assert.equal(shout.speech, true);
  assert.equal(pause.silent, true);
  assert.equal(pause.level, 'normal');
  assert.equal(p.last, pause);
  for (let i = 0; i < 60; i++) say('word');
  assert.equal(p.history.length, 40);
  p.recalibrate();
  assert.equal(p.history.length, 0);
});

// Real readings (2026-10-10). AirPods compress shouts to +8..+10 dB over normal
// (the laptop mic gave +14..+15 for the same shout); normal speech reached +5.1.
test('real-mic readings: AirPods shouts are shouts, normal wobble stays normal-ish', () => {
  const { say, calibrate } = speaker();
  calibrate();
  for (const d of [8.2, 8.3, 9.0, 9.7, 13.8, 15.2]) assert.equal(say('WOW', { db: NORMAL + d }).level, 'shout', `+${d}`);
  for (const d of [-0.9, 1.5, 2.2, 3.1]) assert.equal(say('word', { db: NORMAL + d }).level, 'normal', `+${d}`);
  assert.notEqual(say('Test', { db: NORMAL + 5.1 }).level, 'shout'); // the one outlier: at most one step up
});
