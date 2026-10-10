import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gate } from '../control/gate.js';

const RATE = 16000;
const amp = (db) => Math.sqrt(2) * 10 ** (db / 20); // sine amplitude for an RMS level
const run = (gate, input) => Float32Array.from(input, (x) => gate.push(x));
const energy = (x, a, b) => { let s = 0; for (let i = Math.max(0, Math.round(a * RATE)); i < Math.min(x.length, Math.round(b * RATE)); i++) s += x[i] * x[i]; return s; };

// Seconds of signal: [start, end, dBFS] tone bursts on top of a quiet bed.
function scene(sec, bursts, bedDb = -60) {
  const x = new Float32Array(Math.round(sec * RATE));
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE;
    x[i] = amp(bedDb) * Math.sin(2 * Math.PI * 330 * t);
    for (const [a, b, db] of bursts) if (t >= a && t < b) x[i] = amp(db) * Math.sin(2 * Math.PI * 180 * t);
  }
  return x;
}

test('with no threshold it passes everything, delayed by the lookahead', () => {
  const g = new Gate();
  const x = scene(1, [[0.3, 0.6, -20]]);
  const y = run(g, x);
  assert.equal(y.length, x.length);
  const d = g.delaySec * RATE;
  assert.equal(d, 2400);
  for (let i = d + 200; i < x.length; i += 97) assert.ok(Math.abs(y[i] - x[i - d]) < 1e-6, `sample ${i}`);
});

test('silences background quieter than the threshold', () => {
  const g = new Gate();
  g.setThreshold(-38);
  const y = run(g, scene(2, [], -45)); // steady chatter-level bed, no main speaker
  assert.equal(energy(y, 0, 2), 0);
});

test('passes the main speaker, from just before the word to just after it', () => {
  const g = new Gate();
  g.setThreshold(-38);
  const x = scene(2, [[0.6, 1.0, -20]], -45);
  const y = run(g, x);
  const late = (t) => t + g.delaySec; // output time of input time t
  // the whole word, delayed, comes through at full strength
  assert.ok(energy(y, late(0.6), late(1.0)) > 0.99 * energy(x, 0.6, 1.0));
  // ~120 ms of lead-in before it (consonant onsets) and ~350 ms of tail after it
  assert.ok(energy(y, late(0.48), late(0.6)) > 0.9 * energy(x, 0.48, 0.6));
  assert.ok(energy(y, late(1.0), late(1.3)) > 0.9 * energy(x, 1.0, 1.3));
  // but the chatter well before and after stays silent
  assert.equal(energy(y, late(0), late(0.4)), 0);
  assert.equal(energy(y, late(1.45), 2), 0);
});

test('fades instead of clicking', () => {
  const g = new Gate();
  g.setThreshold(-38);
  const y = run(g, scene(1.5, [[0.5, 0.8, -20]], -45));
  let worst = 0;
  for (let i = 1; i < y.length; i++) worst = Math.max(worst, Math.abs(y[i] - y[i - 1]));
  // the steepest step stays within what the 180 Hz tone itself does sample to sample
  assert.ok(worst <= amp(-20) * 2 * Math.PI * 180 / RATE * 1.05, `step ${worst}`);
});

test('a new threshold applies from then on; -Infinity turns the gate off', () => {
  const g = new Gate();
  g.setThreshold(-38);
  const quiet = scene(1, [], -45);
  assert.equal(energy(run(g, quiet), 0.3, 1), 0);
  g.setThreshold(-Infinity);
  assert.ok(energy(run(g, quiet), 0.3, 1) > 0.9 * energy(quiet, 0.3, 1));
});
