import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameFeatures } from '../control/features.js';

const SR = 48000;
const N = Math.round(SR * 0.033); // one worklet frame
const tone = (hz, amp, sr = SR) => Float32Array.from({ length: Math.round(sr * 0.033) }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / sr));
let seed = 1; // deterministic noise
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const noise = (amp) => Float32Array.from({ length: N }, () => amp * rnd());

test('db is RMS in dBFS', () => {
  // A sine of amplitude 0.1 has RMS 0.1/√2 ≈ -23 dBFS.
  assert.ok(Math.abs(frameFeatures(tone(150, 0.1), SR).db - -23) < 0.1);
  assert.ok(Math.abs(frameFeatures(tone(150, 0.01), SR).db - -43) < 0.1);
});

test('a pitched tone in the voice range is voiced', () => {
  for (const hz of [80, 150, 300]) assert.ok(frameFeatures(tone(hz, 0.1), SR).voicing > 0.9, `${hz} Hz`);
  assert.ok(frameFeatures(tone(100, 0.1, 44100), 44100).voicing > 0.9, '44.1 kHz input');
});

test('noise (like a whisper) is not voiced', () => {
  assert.ok(frameFeatures(noise(0.1), SR).voicing < 0.3);
  assert.ok(frameFeatures(noise(0.03), SR).voicing < 0.3);
});

test('silence is very quiet and unvoiced', () => {
  const f = frameFeatures(new Float32Array(N), SR);
  assert.ok(f.db < -70);
  assert.equal(f.voicing, 0);
});

test('results do not depend on earlier calls', () => {
  const a = frameFeatures(tone(150, 0.1), SR);
  frameFeatures(tone(220, 0.1, 44100), 44100); // different frame length in between
  frameFeatures(noise(0.1), SR);
  assert.deepEqual(frameFeatures(tone(150, 0.1), SR), a);
});
