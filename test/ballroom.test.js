// Main speaker only, in a ballroom: background chatter (six voices), room
// noise, claps, and someone talking nearby: at the next seat, at the main
// speaker's own pitch, and leaning in. Synthetic voices (scripts/scenes.mjs),
// deterministic, no network. Real voices: ballroom-voices.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthScene, measure, gateScene, passed, LEVEL } from '../scripts/scenes.mjs';
import { Prosody } from '../control/prosody.js';
import { frameFeatures, VOICED_FRAME } from '../control/features.js';
import { Gate } from '../control/gate.js';

const deps = { Prosody, frameFeatures, Gate, VOICED_FRAME };
const loud = synthScene();                              // chatter at LEVEL.babble per voice
const quiet = synthScene({ babbleDb: LEVEL.babble - 10 });
const spans = (scene, who, kind) => scene.spans.filter((s) => s.who === who && (!kind || s.kind === kind));
const tail = (scene) => ({ start: scene.audio.length / scene.rate - 0.5, end: scene.audio.length / scene.rate });

for (const [room, scene] of [['loud room', loud], ['quieter room', quiet]]) {
  const { prosody, styled } = measure(scene, deps);

  test(`${room}: calibrates on the main speaker, not the chatter`, () => {
    assert.ok(prosody.calibrated);
    assert.ok(Math.abs(prosody.pitch - 180) < 9, `pitch ${prosody.pitch}`);
  });

  test(`${room}: every main-speaker word is kept, at the right level`, () => {
    for (const s of spans(scene, 'main')) {
      const w = styled.get(s);
      assert.equal(w.background, undefined, `${s.kind} at ${s.start.toFixed(2)} s was dropped: ${w.background}`);
      const want = { calib: 'normal', normal: 'normal', whisper: 'whisper', shout: 'shout' }[s.kind];
      assert.equal(w.level, want, `${s.kind} at ${s.start.toFixed(2)} s`);
    }
  });

  test(`${room}: someone talking nearby is ignored (next seat, same pitch, leaning in)`, () => {
    for (const s of spans(scene, 'nearby')) assert.match(styled.get(s).background ?? '', /someone else/, `${s.kind} at ${s.start.toFixed(2)} s`);
  });

  test(`${room}: claps are never loud or shouted`, () => {
    for (const s of spans(scene, 'clap')) assert.ok(!['loud', 'shout'].includes(styled.get(s).level));
  });

  test(`${room}: speech-to-text hears all of the main speaker, whispers included`, () => {
    const g = gateScene(scene, deps);
    for (const s of spans(scene, 'main')) assert.ok(passed(g, s) > 0.95, `${s.kind} at ${s.start.toFixed(2)} s: ${passed(g, s)}`);
  });
}

test('quieter room: the gate keeps the next seat and the chatter away from speech-to-text', () => {
  const g = gateScene(quiet, deps);
  for (const s of [...spans(quiet, 'nearby', 'far'), ...spans(quiet, 'nearby', 'far-same')]) {
    assert.ok(passed(g, s) < 0.05, `${s.kind} at ${s.start.toFixed(2)} s: ${passed(g, s)}`);
  }
  assert.ok(passed(g, tail(quiet)) < 0.1, `chatter in the last pause: ${passed(g, tail(quiet))}`);
});

test('with the filter off, everyone is captioned and speech-to-text hears everything', () => {
  const { styled } = measure(quiet, deps, { focus: false });
  for (const s of spans(quiet, 'nearby')) assert.equal(styled.get(s).background, undefined);
  const g = gateScene(quiet, deps, { focus: false });
  for (const s of spans(quiet, 'nearby')) assert.ok(passed(g, s) > 0.95);
});
