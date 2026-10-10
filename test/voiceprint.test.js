// Voiceprints with a stand-in model: the fake embedding is the direction of
// the audio's tone frequency, so two tones close in pitch "sound like" the same
// person and far apart do not. The real model: scripts/eval-voiceprint.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioRing, Voiceprints, VOICE, cosine, decide } from '../control/voiceprint-core.js';
import { Prosody } from '../control/prosody.js';
import { Speakers } from '../control/speakers.js';
import { CALIBRATE_WORDS } from '../control/prosody.js';

const RATE = 16000;
const ROOM = -60;

// Frequency from zero crossings → an angle; 180 Hz points along x.
async function fakeEmbed(audio) {
  let zc = 0, sounding = 0; // only the samples with sound in them (padding is silent)
  for (let i = 1; i < audio.length; i++) {
    if (audio[i] !== 0) sounding++;
    if (audio[i - 1] !== 0 && audio[i] !== 0 && (audio[i - 1] < 0) !== (audio[i] < 0)) zc++;
  }
  const hz = zc / 2 / (Math.max(1, sounding) / RATE);
  const a = (hz - 180) / 40;
  return [Math.cos(a), Math.sin(a)];
}

/** A room where people speak: frames go to prosody, audio to the ring. */
function room(prosody, { embed = fakeEmbed } = {}) {
  const ring = new AudioRing({ rate: RATE, seconds: 60 });
  const vp = new Voiceprints({ embed, ring, rate: RATE });
  let t = 0;
  const play = (sec, { hz = 0, db = ROOM, voicing = 0.05 }) => {
    const n = Math.round(sec * RATE), x = new Float32Array(n);
    const amp = Math.SQRT2 * 10 ** (db / 20);
    for (let i = 0; i < n; i++) x[i] = hz ? amp * Math.sin(2 * Math.PI * hz * (t + i / RATE)) : 0;
    for (let k = 1; k * 0.033 <= sec + 1e-9; k++) prosody.push(t + k * 0.033, db, voicing, voicing >= 0.45 ? hz : 0);
    t += sec;
    ring.push(x, t);
  };
  /** A word: a short pause, then voice. Returns its span. */
  const word = ({ hz = 180, db = -30, voicing = 0.8, sec = 0.4 } = {}) => {
    play(0.15, {});
    const start = t;
    play(sec, { hz, db, voicing });
    return [start, t];
  };
  const say = (opts) => { const [a, b] = word(opts); return prosody.styleWord('w', a, b); };
  play(2, {});
  return { vp, ring, word, say, play, now: () => t };
}

test('cosine and decide: long lines need 0.6 to match, under 0.45 is someone else', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 2])) < 1e-9);
  assert.equal(decide([0.7], 2).verdict, 'match');
  assert.equal(decide([0.5], 2).verdict, 'unsure');
  assert.equal(decide([0.4], 2).verdict, 'other');
  // Short lines: more evidence before dropping anything
  assert.equal(decide([0.4], 0.6).verdict, 'unsure');
  assert.equal(decide([0.2], 0.6).verdict, 'other');
  assert.equal(decide([null, null], 2), null);
  // Several profiles: the best must clearly beat the next
  assert.deepEqual([decide([0.3, 0.8], 2).verdict, decide([0.3, 0.8], 2).best], ['match', 1]);
  assert.equal(decide([0.75, 0.72], 2).verdict, 'unsure');
});

test('the audio ring returns audio by time and forgets what is too old', () => {
  const ring = new AudioRing({ rate: 100, seconds: 2 });
  for (let s = 0; s < 3; s++) ring.push(Float32Array.from({ length: 100 }, () => s + 1), s + 1); // second s holds value s+1
  assert.deepEqual([...ring.slice(2.0, 2.05)], [3, 3, 3, 3, 3]);
  assert.deepEqual([...ring.slice(1.98, 2.02)], [2, 2, 3, 3]);
  assert.equal(ring.slice(0, 0.9), null);              // gone
  assert.equal(ring.slice(0.5, 1.02).length, 2);        // only the part still held
  assert.deepEqual([...ring.slice(2.99, 5)], [3]);      // nothing after the newest sample
  assert.deepEqual([...new AudioRing({ rate: 4 }).push(Int16Array.from([16384, -32768]), 1) ?? []], []);
});

test('calibration enrolls the voiceprint; then the speaker matches and someone else does not', async () => {
  const p = new Prosody();
  const { vp, word, say } = room(p);
  assert.equal(await vp.identify(p, ...word()), null); // nobody enrolled yet
  for (let i = 0; i < CALIBRATE_WORDS; i++) say();
  await vp.refresh(p);
  assert.equal(vp.count(p), 1);
  const me = await vp.identify(p, ...word({ sec: 1.2, hz: 185 }));
  assert.equal(me.verdict, 'match');
  const them = await vp.identify(p, ...word({ sec: 1.2, hz: 120, db: -33 }));
  assert.equal(them.verdict, 'other');
  assert.ok(them.score < VOICE.OTHER);
});

test('a whispered line is never judged by voiceprint (no voice in it)', async () => {
  const p = new Prosody();
  const { vp, word, say } = room(p);
  for (let i = 0; i < CALIBRATE_WORDS; i++) say();
  const v = await vp.identify(p, ...word({ hz: 120, voicing: 0.1, db: -40, sec: 1.2 }));
  assert.equal(v.verdict, 'unsure');
  assert.match(v.reason, /whisper/);
});

test('audio at the room noise or too short is not judged', async () => {
  const p = new Prosody();
  const { vp, word, say, play, now } = room(p);
  for (let i = 0; i < CALIBRATE_WORDS; i++) say();
  play(0.2, {});
  const t = now();
  play(1, {});
  const quiet = await vp.identify(p, t, now());
  assert.match(quiet.reason, /no voice/);
  assert.match((await vp.identify(p, ...word({ sec: 0.2 }))).reason, /short/);
});

test('chatter heard before the speaker talked never becomes their voiceprint', async () => {
  const p = new Prosody();
  const { vp, say, word } = room(p);
  for (let i = 0; i < 4; i++) say({ hz: 120, db: -45 }); // quiet chatter, at another pitch
  for (let i = 0; i < CALIBRATE_WORDS; i++) say();        // then the main speaker, close to the mic
  await vp.refresh(p);
  assert.equal((await vp.identify(p, ...word({ sec: 1.2 }))).verdict, 'match');
  assert.equal((await vp.identify(p, ...word({ sec: 1.2, hz: 120, db: -32 }))).verdict, 'other');
});

test('recalibrating (New judge) forgets the voiceprint; the filter off turns it off', async () => {
  const p = new Prosody();
  const { vp, word, say } = room(p);
  for (let i = 0; i < CALIBRATE_WORDS; i++) say();
  await vp.refresh(p);
  p.recalibrate();
  await vp.refresh(p);
  assert.equal(vp.count(p), 0);
  assert.equal(await vp.identify(p, ...word({ sec: 1.2 })), null);
  for (let i = 0; i < CALIBRATE_WORDS; i++) say({ hz: 120 }); // the new judge
  p.focus = false;
  assert.equal(await vp.identify(p, ...word({ sec: 1.2 })), null);
  p.focus = true;
  assert.equal((await vp.identify(p, ...word({ sec: 1.2, hz: 120 }))).verdict, 'match'); // the new judge
  assert.equal((await vp.identify(p, ...word({ sec: 1.2, hz: 180 }))).verdict, 'other'); // the last judge is someone else now
});

test('a line judged someone else is dropped whole by prosody, whispered words too', () => {
  const p = new Prosody();
  const { say } = room(p);
  for (let i = 0; i < CALIBRATE_WORDS; i++) say();
  p.voice = { verdict: 'other', best: 0, score: 0.1, scores: [0.1], seconds: 2 };
  assert.match(say({ voicing: 0.1, db: -40 }).background, /voiceprint 0.10/);
  assert.match(say().background, /voiceprint/);
  p.voice = { verdict: 'match', best: 0, score: 0.8, scores: [0.8], seconds: 2 };
  assert.equal(say().background, undefined);
  p.voice = null;
  assert.equal(say().background, undefined);
});

test('several speakers: each enrolls their own voiceprint, lines go to the matching one, strangers are dropped', async () => {
  const p = new Speakers(2);
  // Fake voiceprints for two people: 180 Hz and 140 Hz point different ways.
  const { vp, say, word } = room(p, {
    embed: async (audio) => {
      const [x, y] = await fakeEmbed(audio);
      return [x, y, 0];
    },
  });
  for (let i = 0; i < CALIBRATE_WORDS; i++) say({ hz: 180, db: -30 });
  await vp.refresh(p);
  assert.equal(await vp.identify(p, ...word()), null); // still enrolling: nothing judged
  assert.ok(p.advance());
  for (let i = 0; i < CALIBRATE_WORDS; i++) say({ hz: 140, db: -32 });
  await vp.refresh(p);
  assert.ok(p.advance());
  assert.equal(vp.count(p), 2);

  const [a, b] = word({ hz: 140, db: -32, sec: 1.2 });
  p.voice = await vp.identify(p, a, b);
  assert.deepEqual([p.voice.verdict, p.voice.best], ['match', 1]);
  assert.equal(p.styleWord('w', a, b).speaker, 2);

  const [c, d] = word({ hz: 90, db: -31, sec: 1.2 });
  p.voice = await vp.identify(p, c, d);
  assert.equal(p.voice.verdict, 'other');
  assert.match(p.styleWord('w', c, d).background, /no enrolled voice/);
  p.voice = null;
});

test('the voiceprint also learns from the rest of the first sentence, until it exists', async () => {
  const p = new Prosody();
  const { vp, say } = room(p);
  for (let i = 0; i < CALIBRATE_WORDS; i++) say();
  for (let i = 0; i < 4; i++) say();                           // the rest of the calibration sentence
  say({ hz: 120, db: -48 });                                    // someone far away: not theirs, not learned
  assert.equal(p.enrollSpans.length, CALIBRATE_WORDS + 4);
  await vp.refresh(p);
  p.voice = { verdict: 'match', best: 0, score: 0.8, scores: [0.8], seconds: 2 };
  say();                                                        // once lines are judged, enrollment stops
  p.voice = null;
  assert.equal(p.enrollSpans.length, CALIBRATE_WORDS + 4);
  for (let i = 0; i < 20; i++) say();                           // and it is capped at ~3 s more
  assert.ok(p.enrollExtra.reduce((s, w) => s + w.end - w.start, 0) < 3.5);
  p.recalibrate();
  assert.equal(p.enrollSpans.length, 0);
});
