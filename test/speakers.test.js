import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Speakers } from '../control/speakers.js';
import { Transcript } from '../control/transcript.js';

function scene(count = 2) {
  const p = new Speakers(count);
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
  const say = (db, pitch, voicing) => {
    const w = span(db, pitch, voicing);
    return p.styleWord(w.text, w.start, w.end);
  };
  const enroll = (db, pitch) => { for (let i = 0; i < 6; i++) say(db, pitch); };
  const ready = () => { enroll(-25, 110); p.advance(); enroll(-35, 240); p.advance(); };
  return { p, say, span, enroll, ready };
}

test('enrolls each speaker separately and requires an explicit handoff', () => {
  const { p, enroll } = scene();
  assert.equal(p.advance(), false);
  enroll(-25, 110);
  assert.equal(p.enrollmentReady, true);
  assert.equal(p.enrollmentIndex, 0);
  assert.equal(p.profiles[1].calibration, 0);
  assert.equal(p.advance(), true);
  assert.equal(p.suppressCaptions, true);
  enroll(-35, 240);
  assert.equal(p.advance(), true);
  assert.equal(p.suppressCaptions, false);
  assert.equal(p.calibration, 1);
  assert.deepEqual(p.profiles.map((x) => [x.ref, x.pitch]), [[-25, 110], [-35, 240]]);
});

test('uses each speaker’s own loudness and keeps the quieter enrolled person', () => {
  const { p, say, ready } = scene();
  ready();
  assert.equal(say(-25, 110).speaker, 1);
  const quiet = say(-35, 240);
  assert.equal(quiet.speaker, 2);
  assert.equal(quiet.level, 'normal');
  assert.equal(say(-26, 240).level, 'shout');
  assert.equal(p.gateDb(), -53);
});

test('rejects unmatched voiced speech even at high volume, without teaching profiles', () => {
  const { p, say, ready } = scene();
  ready();
  const refs = p.profiles.map((x) => x.ref);
  assert.match(say(-20, 165).background, /no enrolled/);
  assert.deepEqual(p.profiles.map((x) => x.ref), refs);
  p.focus = false;
  assert.equal(say(-20, 165).background, undefined);
  assert.equal(p.gateDb(), -Infinity);
});

test('late word timings cannot enroll the next person or enter the conversation', () => {
  const { p, span, enroll } = scene();
  const old = span(-25, 110);
  enroll(-25, 110);
  p.advance();
  assert.ok(p.styleWord('late', old.start, old.end).background);
  assert.equal(p.profiles[1].calibration, 0);
  enroll(-35, 240);
  p.advance();
  assert.ok(p.styleWord('late', old.start, old.end).background);
});

test('whispers retain continuity; silence cannot match a speaker', () => {
  const { say, ready } = scene();
  ready();
  say(-35, 240);
  assert.equal(say(-44, 0, 0.1).speaker, 2);
  assert.ok(say(-60, 0, 0).background);
});

test('recalibration clears every profile and requires all participants again', () => {
  const { p, ready } = scene(3);
  ready(); // third person still needs enrollment
  assert.equal(p.enrolling, true);
  p.recalibrate();
  assert.equal(p.enrollmentIndex, 0);
  assert.equal(p.suppressCaptions, true);
  assert.ok(p.profiles.every((x) => x.ref == null && x.pitch == null));
});

test('a single speaker retains the original automatic calibration', () => {
  const { p, enroll, say } = scene(1);
  assert.equal(p.suppressCaptions, false);
  enroll(-25, 110);
  assert.equal(p.calibration, 1);
  assert.equal(say(-15, 110).level, 'shout');
});

test('multi-speaker transcript excludes calibration and filters individual conversation words', async () => {
  const { p, span } = scene();
  const sent = [], tr = new Transcript({ prosody: p, send: (m) => sent.push(m), classify: () => null, mood: () => null });
  tr.t0 = 0;
  for (const [db, pitch] of [[-25, 110], [-35, 240]]) {
    const words = Array.from({ length: 6 }, () => span(db, pitch));
    tr.partial('hello hello hello hello hello hello');
    await tr.committedTimed({ text: 'hello hello hello hello hello hello', words });
    assert.equal(sent.length, 0);
    assert.equal(tr.lines.length, 0);
    assert.equal(p.advance(), true);
    tr.resetCaption();
  }
  const words = [span(-25, 110), span(-20, 165), span(-20, 165), span(-35, 240)];
  tr.partial('hello hello hello hello');
  assert.equal(sent.length, 0); // focused partials cannot bypass the filter
  await tr.committedTimed({ text: 'hello hello hello hello', words });
  assert.deepEqual(tr.lines[0].words.map((w) => w.speaker), [1, 2]);
  assert.equal(tr.lines[0].text, 'hello hello');
  await tr.finalize('untimed stranger', null);
  assert.equal(sent.at(-1).words.length, 0);
  assert.equal(tr.lines.length, 1);
});

test('invalid speaker counts are rejected', () => {
  for (const count of [0, -1, 1.5, NaN, 33]) assert.throws(() => new Speakers(count));
});

test('enrollment waits for pitch and ignores early whispers', () => {
  const { p, enroll, say } = scene();
  say(-35, 0, 0.1);
  assert.equal(p.profiles[0].calibration, 0);
  enroll(-25, 0);
  assert.equal(p.enrollmentReady, false);
  assert.equal(p.advance(), false);
  for (let i = 0; i < 3; i++) say(-25, 110);
  assert.equal(p.enrollmentReady, true);
});

test('a reconnect during enrollment preserves profiles and resumes the current speaker', async () => {
  const { p, enroll, span } = scene();
  enroll(-25, 110);
  p.advance();
  const tr = new Transcript({ prosody: p, send: () => assert.fail('enrollment was captioned'), classify: () => null, mood: () => null });
  tr.t0 = 0;
  await tr.committedTimed({ text: 'hello', words: [span(-35, 240)] });
  tr.resync();
  const words = Array.from({ length: 5 }, () => span(-35, 240));
  const origin = words[0].start - 0.1;
  tr.t0 = origin;
  await tr.committedTimed({ text: 'hello hello hello hello hello', words: words.map((w) => ({ ...w, start: w.start - origin, end: w.end - origin })) });
  assert.equal(p.enrollmentReady, true);
  assert.equal(p.profiles[0].pitch, 110);
  assert.equal(p.profiles[1].pitch, 240);
});

// ---------- review fixes ----------
test('a speaker shouting with a raised pitch is still that speaker (shouting raises pitch)', () => {
  const { say, ready } = scene();
  ready();
  // speaker 1 (110 Hz, -25 dB) shouts: +12 dB, pitch up 9 semitones
  const shout = say(-13, 110 * 2 ** (9 / 12));
  assert.equal(shout.background, undefined);
  assert.equal(shout.speaker, 1);
  assert.equal(shout.level, 'shout');
  // ...but a quieter voice at that pitch is still nobody enrolled
  assert.ok(say(-24, 110 * 2 ** (9 / 12)).background);
});

test('with the filter off, words timed onto a pause are kept, not dropped', () => {
  const { p, say, ready } = scene();
  ready();
  p.focus = false;
  const w = say(-60, 0, 0);
  assert.equal(w.background, undefined);
});

test('with the filter off, untimed lines are captioned plainly', async () => {
  const { p, ready } = scene();
  ready();
  p.focus = false;
  const sent = [], tr = new Transcript({ prosody: p, send: (m) => sent.push(m), classify: () => null, mood: () => null });
  await tr.finalize('no timestamps here', null);
  assert.deepEqual(sent.at(-1).words.map((w) => w.word), ['no', 'timestamps', 'here']);
});

test('chatter transcribed before the first person speaks cannot become their profile', () => {
  const { p, say } = scene();
  for (let i = 0; i < 4; i++) say(-43, 150); // "How was your drive today?" from the next table
  for (let i = 0; i < 6; i++) say(-20, 112); // speaker 1 next to the mic
  assert.equal(p.enrollmentReady, true);
  assert.ok(Math.abs(p.profiles[0].ref - -20) < 0.01);
  assert.equal(p.profiles[0].pitch, 112);
});

test('if chatter made a speaker look ready, their own (louder) words take over before the handoff', () => {
  const { p, say } = scene();
  for (let i = 0; i < 6; i++) say(-43, 150);
  assert.equal(p.enrollmentReady, true); // looks ready on chatter alone...
  say(-20, 112);
  assert.equal(p.enrollmentReady, false); // ...until the real speaker talks
  for (let i = 0; i < 5; i++) say(-20, 112);
  assert.equal(p.enrollmentReady, true);
  assert.ok(Math.abs(p.profiles[0].ref - -20) < 0.01);
});
