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
  const frames = (dur, db, voicing, pitch = 0) => {
    for (const end = t + dur - 1e-9; t < end;) { t += FRAME; p.push(t, db, voicing, voicing >= 0.45 ? pitch : 0); }
  };
  const span = (dur, db, voicing, pitch) => { frames(0.2, ROOM, 0.05); const start = t; frames(dur, db, voicing, pitch); return [start, t]; };
  const say = (text, { db = NORMAL, voicing = VOICED, dur = 0.3, pitch = 0 } = {}) => p.styleWord(text, ...span(dur, db, voicing, pitch));
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
  // A loud burst with no voice in it (clap, bump, breath on the mic) is not loud.
  assert.equal(say('(clap)', { voicing: UNVOICED, db: NORMAL + 12 }).level, 'normal');
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

// ---------- main speaker only ----------
const HER = 180, HIM = 110; // Hz: a main speaker and someone else nearby (8.5 semitones apart)
function mainSpeaker(pitch = HER) {
  const sp = speaker();
  for (let i = 0; i < CALIBRATE_WORDS; i++) sp.say('hello', { pitch });
  return sp;
}

test('calibration learns the main speaker\'s pitch', () => {
  const { p } = mainSpeaker();
  assert.equal(p.pitch, HER);
});

test('a quieter voice at another pitch is someone else and is ignored', () => {
  const { p, say } = mainSpeaker();
  const ref = p.ref;
  const w = say('nearby', { db: NORMAL - 8, pitch: HIM });
  assert.match(w.background, /someone else/);
  assert.equal(p.ref, ref); // teaches nothing
  assert.match(p.last.background, /110 Hz vs your 180 Hz/);
});

test('the main speaker speaking softly, at their own pitch, is kept', () => {
  const { say } = mainSpeaker();
  const soft = say('quiet', { db: NORMAL - 7, pitch: HER * 2 ** (2 / 12) }); // +2 semitones
  assert.equal(soft.background, undefined);
  assert.equal(soft.level, 'soft');
});

test('a clearly voiced word far under normal is someone else, even at the main speaker\'s pitch', () => {
  const { say } = mainSpeaker();
  assert.match(say('chatter', { db: NORMAL - 14, pitch: HER }).background, /14\.0 dB under your normal/);
});

test('whispers are always the main speaker\'s (no voice, so no pitch to check)', () => {
  const { say } = mainSpeaker();
  const w = say('psst', { db: NORMAL - 9, voicing: UNVOICED });
  assert.equal(w.background, undefined);
  assert.equal(w.level, 'whisper');
});

test('anything at the main speaker\'s level or louder is theirs, even at a new pitch (shouting raises pitch)', () => {
  const { say } = mainSpeaker();
  const shout = say('WON', { db: NORMAL + 11, pitch: HER * 2 ** (9 / 12) });
  assert.equal(shout.background, undefined);
  assert.equal(shout.level, 'shout');
  assert.equal(say('hey', { db: NORMAL - 2, pitch: HIM }).background, undefined); // within 3 dB of normal
});

test('without pitch, a voiced word is only ruled someone else when far under normal', () => {
  const { say } = mainSpeaker(0); // no pitch measured during calibration
  assert.equal(say('far', { db: NORMAL - 14 }).background !== undefined, true);
  assert.equal(say('soft', { db: NORMAL - 7 }).background, undefined);
});

test('turning the filter off captions everyone', () => {
  const { p, say } = mainSpeaker();
  p.focus = false;
  assert.equal(say('nearby', { db: NORMAL - 8, pitch: HIM }).background, undefined);
  assert.equal(p.gateDb(), -Infinity);
});

test('the audio gate opens just under the main speaker\'s whispers, never into the room noise', () => {
  const sp = speaker();
  assert.ok(Math.abs(sp.p.gateDb() - (ROOM + 10)) < 0.01); // before calibration: anything that counts as speech
  for (let i = 0; i < CALIBRATE_WORDS; i++) sp.say('hello', { pitch: HER });
  assert.ok(Math.abs(sp.p.gateDb() - (NORMAL - 18)) < 0.01);
  const close = speaker(); // a quiet room... versus a loud one where the floor is only 20 dB down
  close.frames(5, NORMAL - 20, 0.05);
  for (let i = 0; i < CALIBRATE_WORDS; i++) close.say('hello');
  assert.ok(close.p.gateDb() >= close.p.noiseDb + 6 - 1e-9);
});

test('the main speaker\'s pitch slowly follows them', () => {
  const { p, say } = mainSpeaker();
  for (let i = 0; i < 10; i++) say('word', { pitch: 190 });
  assert.ok(p.pitch > HER && p.pitch < 190);
});
