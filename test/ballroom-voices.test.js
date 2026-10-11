// The ballroom with real voices (macOS `say`): Samantha is the main speaker,
// Daniel (lower pitch) and Tessa (Samantha's pitch range) talk nearby, four
// more voices are the chatter. Sentence-level spans, no network. Skipped where
// `say` isn't available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSay, voicesScene, measure, gateScene, passed } from '../scripts/scenes.mjs';
import { Prosody } from '../control/prosody.js';
import { frameFeatures, VOICED_FRAME } from '../control/features.js';
import { Gate } from '../control/gate.js';

const skip = !hasSay() && 'macOS say not available';
const deps = { Prosody, frameFeatures, Gate, VOICED_FRAME };
const scene = skip ? null : await voicesScene();
const run = skip ? null : measure(scene, deps);
const each = (who) => scene.spans.filter((s) => s.who === who);

test('real voices: calibrates on the main speaker', { skip }, () => {
  assert.ok(run.prosody.calibrated);
  assert.ok(run.prosody.pitch > 150 && run.prosody.pitch < 200, `pitch ${run.prosody.pitch}`); // Samantha ≈ 175 Hz
});

test('real voices: the main speaker is kept at the right level (normal, whisper, shout)', { skip }, () => {
  for (const s of each('main')) {
    const w = run.styled.get(s);
    assert.equal(w.background, undefined, `"${s.text}" was dropped: ${w.background}`);
    assert.equal(w.level, { calib: 'normal', normal: 'normal', whisper: 'whisper', shout: 'shout' }[s.kind], `"${s.text}"`);
  }
});

test('real voices: people talking nearby are ignored', { skip }, () => {
  for (const s of each('nearby')) assert.match(run.styled.get(s).background ?? '', /someone else/, `"${s.text}"`);
});

test('real voices: speech-to-text hears all of the main speaker', { skip }, () => {
  const g = gateScene(scene, deps);
  for (const s of each('main')) assert.ok(passed(g, s) > 0.95, `"${s.text}": ${passed(g, s)}`);
});
