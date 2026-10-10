// Tone of voice vs. the speaker's normal → line energy (excited vs. calm, angry vs. sad).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prosody, CALIBRATE_WORDS } from '../control/prosody.js';
import { toneFeatures, toneEnergy, decideEmotion } from '../control/tone.js';

function speaker() {
  const p = new Prosody();
  let t = 0;
  const frames = (sec, db, voicing, pitch) => { for (const end = t + sec - 1e-9; t < end;) { t += 0.033; p.push(t, db, voicing, pitch); } };
  frames(2, -60, 0.05, 0);
  const line = (sec, db, pitchAt) => {
    frames(0.2, -60, 0.05, 0);
    const start = t;
    for (const end = start + sec - 1e-9; t < end;) { t += 0.033; p.push(t, db, 0.8, pitchAt((t - start) / sec)); }
    return [start, t];
  };
  for (let i = 0; i < CALIBRATE_WORDS; i++) { const [a, b] = line(0.3, -30, () => 180); p.styleWord('hi', a, b); }
  return { p, line };
}

test('a line spoken higher, louder and livelier than normal has more energy; low and flat has less', () => {
  const { p, line } = speaker();
  const normal = toneFeatures(p, ...line(1.5, -30, (x) => 180 * 2 ** ((x - 0.5) * 0.75)), 6); // ±4.5 st, at their pitch
  const excited = toneFeatures(p, ...line(1.5, -26, (x) => 290 * 2 ** ((x - 0.5) * 1.0)), 6);  // +8 st, +4 dB, wider
  const flat = toneFeatures(p, ...line(1.5, -34, (x) => 150 * 2 ** ((x - 0.5) * 0.2)), 6);     // -3 st, -4 dB, flat
  assert.ok(Math.abs(normal.pitch) < 1 && Math.abs(normal.loud) < 1, JSON.stringify(normal));
  assert.ok(excited.pitch > 7 && excited.loud > 3, JSON.stringify(excited));
  assert.ok(Math.abs(toneEnergy(normal) - 0.5) < 0.05);
  assert.ok(toneEnergy(excited) > 0.8);
  assert.ok(toneEnergy(flat) < 0.3);
  assert.equal(toneEnergy(null), 0.5);
});

test('the words choose positive or negative; the voice chooses excited or calm', () => {
  const joy = { joy: 0.9, neutral: 0.05 }, anger = { anger: 0.9, neutral: 0.05 }, flat = { neutral: 0.95 };
  const excited = { loud: 4, pitch: 8, range: 12, voiced: 0.9, rate: 3 }, low = { loud: -4, pitch: -3, range: 4, voiced: 0.9, rate: 2 };
  assert.equal(decideEmotion(joy, 'best day ever', excited, null, 0.7).emotion, 'happy');
  assert.equal(decideEmotion(joy, 'best day ever', low, null, 0.7).emotion, 'calm');
  assert.equal(decideEmotion(anger, 'I hate this', excited, null, 0.7).emotion, 'angry');
  assert.equal(decideEmotion(anger, 'I hate this', low, null, 0.7).emotion, 'sad');
  assert.equal(decideEmotion(flat, 'the map is left', excited, null, 0.7).emotion, 'neutral'); // white beats a guessed color
});

test('before calibration there is no tone (the line falls back to its word sizes)', () => {
  const p = new Prosody();
  assert.equal(p.toneOf(0, 1, 3), null);
});

// How a judge acts on the teach cards (vs. their normal voice), with a little variation per take.
const ACT = {
  neutral: { loud: 0, pitch: 0, range: 8, rate: 3 },
  happy: { loud: 3, pitch: 6, range: 14, rate: 3.5 },
  angry: { loud: 7, pitch: 2, range: 7, rate: 4 },
  sad: { loud: -5, pitch: -3, range: 4, rate: 2 },
};
const take = (mood, k = 0) => Object.fromEntries(Object.entries(ACT[mood]).map(([d, v]) => [d, v + (k % 2 ? 0.4 : -0.3) * (d === 'rate' ? 0.3 : 1)]));

test('teach your tones: after the cards, a neutral sentence said in a taught mood takes that mood', async () => {
  const { ToneBook } = await import('../control/tone.js');
  const book = new ToneBook();
  for (const mood of ['neutral', 'happy', 'angry', 'sad']) book.teach(mood, take(mood));
  assert.deepEqual(book.usable.sort(), ['angry', 'happy', 'sad']);
  for (const mood of ['happy', 'angry', 'sad']) {
    const m = book.match(take(mood, 1));
    assert.deepEqual([m.emotion, m.confident], [mood, true], mood);
  }
  assert.equal(book.match(take('neutral', 1)).confident, false); // their normal voice stays to the words
  // halfway between normal and angry: not sure, so the words decide
  assert.equal(book.match({ loud: 3.5, pitch: 1, range: 7.5, rate: 3.5 }).confident, false);
});

test('a taught mood that sounds like their normal voice is ignored (asks to exaggerate)', async () => {
  const { ToneBook } = await import('../control/tone.js');
  const book = new ToneBook();
  book.teach('neutral', take('neutral'));
  book.teach('angry', { loud: 1, pitch: 0.5, range: 8, rate: 3.1 }); // barely acted
  assert.equal(book.isUsable('angry'), false);
  assert.equal(book.match({ loud: 1, pitch: 0.5, range: 8, rate: 3.1 }), null);
  book.teach('angry', take('angry')); book.teach('angry', take('angry', 1)); // tries again, louder
  assert.equal(book.isUsable('angry'), true);
});

test('each speaker teaches their own moods; New judge forgets them', async () => {
  const { Speakers } = await import('../control/speakers.js');
  const p = new Speakers();
  p.toneBookFor(1).teach('angry', take('angry'));
  assert.deepEqual(p.toneBookFor(1).taught, ['angry']);
  assert.deepEqual(p.toneBookFor(2).taught, []);
  p.recalibrate();
  assert.deepEqual(p.toneBookFor(1).taught, []);
  const solo = new Prosody();
  solo.toneBookFor().teach('sad', take('sad'));
  solo.recalibrate();
  assert.deepEqual(solo.toneBookFor().taught, []);
});
