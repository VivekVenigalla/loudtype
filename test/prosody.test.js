// Prosody with synthetic frames: what the worklet would report, ~30 per second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prosody, LEVELS, THRESHOLDS, CALIBRATE_WORDS } from '../control/prosody.js';

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
