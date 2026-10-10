// Speakers: "main speaker only" (calibrated Prosody) and "label everyone"
// (no calibration; each line's speaker comes from voiceprint-core.js, set on
// `voice` while the line is styled). Synthetic frames, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Speakers } from '../control/speakers.js';
import { Transcript } from '../control/transcript.js';
import { CALIBRATE_WORDS } from '../control/prosody.js';

function scene(opts) {
  const p = new Speakers(opts);
  let t = 0;
  const frames = (db, pitch, n = 12, voicing = 0.8) => {
    for (let i = 0; i < n; i++) p.push(t += 0.033, db, voicing, pitch);
  };
  frames(-60, 0, 60, 0);
  const span = (db, pitch, voicing = 0.8) => {
    frames(-60, 0, 8, 0);
    const start = t;
    frames(db, pitch, 12, voicing);
    return { text: 'hello', start, end: t, type: 'word' };
  };
  /** A word by speaker `who` (0-based, as the voiceprint would say), or with no voiceprint. */
  const say = (db, pitch, { who, voicing } = {}) => {
    const w = span(db, pitch, voicing);
    p.voice = who == null ? null : { verdict: 'match', best: who, score: 0.8, scores: [], seconds: 2 };
    const style = p.styleWord(w.text, w.start, w.end);
    p.voice = null;
    return style;
  };
  return { p, say, span, frames };
}

test('label everyone is the default: no calibration, nobody filtered, speech-to-text hears everything', () => {
  const { p } = scene();
  assert.equal(p.auto, true);
  assert.equal(p.multi, true);
  assert.equal(p.focus, false);
  assert.equal(p.calibration, 1);
  assert.equal(p.gateDb(), -Infinity);
  assert.equal(p.gateUnvoicedDb(), -Infinity);
});

test('each line gets the speaker the voiceprint names; speakers appear as they are heard', () => {
  const { p, say } = scene();
  assert.equal(say(-25, 110, { who: 0 }).speaker, 1);
  assert.equal(say(-35, 240, { who: 1 }).speaker, 2);
  assert.equal(p.profiles.length, 2);
  assert.equal(say(-25, 110, { who: 0 }).speaker, 1);
});

test('without a voiceprint (short line, model loading) a word stays with the last speaker', () => {
  const { say } = scene();
  say(-35, 240, { who: 1 });
  assert.equal(say(-45, 0, { voicing: 0.1 }).speaker, 2);
  assert.equal(say(-35, 240).speaker, 2);
});

test('each speaker gets their own normal loudness, learned from their first words', () => {
  const { p, say } = scene();
  for (let i = 0; i < CALIBRATE_WORDS; i++) assert.equal(say(-25, 110, { who: 0 }).level, 'normal'); // learning
  for (let i = 0; i < CALIBRATE_WORDS; i++) say(-40, 240, { who: 1 });                               // a quieter person
  assert.ok(Math.abs(p.profiles[0].ref + 25) < 1 && Math.abs(p.profiles[1].ref + 40) < 1);
  assert.equal(say(-40, 240, { who: 1 }).level, 'normal');  // their normal, not "whisper"
  assert.equal(say(-30, 240, { who: 1 }).level, 'shout');   // +10 dB for them
  assert.equal(say(-25, 110, { who: 0 }).level, 'normal');  // speaker 1's normal
});

test('the size sensitivity reaches every speaker', () => {
  const { p, say } = scene();
  for (let i = 0; i < CALIBRATE_WORDS; i++) say(-30, 110, { who: 0 });
  assert.equal(say(-24.5, 110, { who: 0 }).level, 'normal'); // +5.5 dB
  p.sensitivity = 1.5;
  assert.equal(say(-24.5, 110, { who: 0 }).level, 'loud');
});

test('New judge forgets every speaker', () => {
  const { p, say } = scene();
  say(-25, 110, { who: 0 });
  say(-35, 240, { who: 1 });
  p.recalibrate();
  assert.equal(p.profiles.length, 0);
  assert.equal(p.focus, false);
  assert.equal(say(-35, 240, { who: 0 }).speaker, 1);
});

test('main speaker only keeps the calibrated, filtered behavior', () => {
  const { p, say } = scene({ auto: false });
  assert.equal(p.multi, false);
  assert.equal(p.focus, true);
  assert.ok(p.calibration < 1);
  for (let i = 0; i < CALIBRATE_WORDS; i++) say(-25, 180);
  assert.ok(p.calibrated);
  assert.equal(say(-25, 180).speaker, undefined);
  assert.match(say(-42, 110).background, /someone else/);
});

test('transcript lines carry their speaker; live words show the guess or the last speaker', async () => {
  const { p, span } = scene();
  const sent = [];
  const who = [0, 1];
  const tr = new Transcript({
    prosody: p,
    send: (m) => sent.push(m),
    classify: () => null,
    mood: () => null,
    identify: (start, end, live) => Promise.resolve(live ? null : { verdict: 'match', best: who.shift(), score: 0.8, scores: [], seconds: 2 }),
  });
  tr.t0 = 0;
  const a = span(-25, 110), b = span(-35, 240);
  await tr.committedTimed({ text: 'hello', words: [a] });
  assert.equal(sent.at(-1).speaker, 1);
  await tr.committedTimed({ text: 'hello', words: [b] });
  assert.equal(sent.at(-1).speaker, 2);
  assert.deepEqual(tr.lines.map((l) => l.speaker), [1, 2]);
  tr.partial('and then');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.at(-1).speaker, 2); // no live guess yet: the last speaker
});

test('splitTurns: a committed line splits at pauses into stretches long enough to identify', async () => {
  const { splitTurns } = await import('../control/transcript.js');
  const w = (start, end) => ({ text: 'x', start, end, type: 'word' });
  // A: 0-1.3 s, pause 0.4 s, B: 1.7-3.0 s, then a short "yeah" after a pause (joins B)
  const turns = splitTurns([w(0, 0.4), w(0.45, 0.9), w(0.95, 1.3), w(1.7, 2.2), w(2.25, 3.0), w(3.4, 3.6)]);
  assert.deepEqual(turns.map((t) => t.length), [3, 3]);
  assert.equal(splitTurns([w(0, 0.3), w(0.6, 0.9)]).length, 1); // too short to be two people
});

test('label everyone: two people in one committed line get their own speakers', async () => {
  const { p, span, frames } = scene();
  const sent = [];
  const asked = [];
  const tr = new Transcript({
    prosody: p, send: (m) => sent.push(m), classify: () => null, mood: () => null,
    identify: (start, end, live) => { if (!live) asked.push([start, end]); return Promise.resolve(live ? null : { verdict: 'match', best: asked.length - 1, score: 0.8, scores: [], seconds: 2 }); },
  });
  tr.t0 = 0;
  const a = [span(-25, 110), span(-25, 110), span(-25, 110)];
  frames(-60, 0, 15, 0); // the handover pause is longer than the pauses inside each turn
  const b = [span(-35, 240), span(-35, 240), span(-35, 240)];
  await tr.committedTimed({ text: 'a a a b b b', words: [...a, ...b] });
  assert.equal(asked.length, 2);
  assert.deepEqual(sent.at(-1).words.map((x) => x.speaker), [1, 1, 1, 2, 2, 2]);
});
