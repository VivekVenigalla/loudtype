// Per-frame voice features, shared by the browser (audio.js) and the offline
// evaluation script, so both measure exactly the same thing.
//
//   db       loudness (RMS in dBFS)
//   voicing  0..1, how periodic the frame is (normalized autocorrelation peak
//            in the 70–400 Hz pitch range). Voiced speech is ~0.5–0.9; a
//            whisper has no vocal-cord vibration, so it stays low (~0.1–0.35)
//            no matter how close the mic is. That makes whispers detectable
//            even when they aren't much quieter than normal speech.
//   pitch    Hz of that periodicity (only meaningful when voiced); tells
//            different speakers apart.

const PITCH_MIN_HZ = 70;
const PITCH_MAX_HZ = 400;
const WORK_RATE = 12000; // downsample before autocorrelation to keep it cheap
const OCTAVE_GUARD = 0.97; // a shorter period within 3% of the best wins (avoids octave-low errors)

export function frameFeatures(samples, sampleRate) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const db = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
  if (db < -70) return { db, voicing: 0, pitch: 0 };
  return { db, ...periodicity(samples, sampleRate) };
}

// Reused between calls: this runs ~30x a second on the audio thread, where
// allocating means garbage collection pauses.
let scratch = new Float32Array(0);
let corr = new Float32Array(0);

function periodicity(samples, sampleRate) {
  // Box-filter downsample to ~12 kHz.
  const step = Math.max(1, Math.round(sampleRate / WORK_RATE));
  const rate = sampleRate / step;
  const n = Math.floor(samples.length / step);
  if (scratch.length < n) scratch = new Float32Array(n);
  const x = scratch; // only x[0..n) is used
  let mean = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < step; k++) s += samples[i * step + k];
    x[i] = s / step;
    mean += x[i];
  }
  mean /= n;
  for (let i = 0; i < n; i++) x[i] -= mean;

  const minLag = Math.floor(rate / PITCH_MAX_HZ);
  const maxLag = Math.min(n - 1, Math.ceil(rate / PITCH_MIN_HZ));
  if (corr.length < maxLag + 2) corr = new Float32Array(maxLag + 2);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      r += x[i] * x[i + lag];
      e1 += x[i] * x[i];
      e2 += x[i + lag] * x[i + lag];
    }
    const c = r / (Math.sqrt(e1 * e2) + 1e-12);
    corr[lag] = c;
    if (c > best) best = c;
  }
  // A periodic signal also correlates at 2, 3… periods; take the first peak
  // that is (nearly) as strong as the best one.
  let period = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const peak = (lag === minLag || corr[lag] >= corr[lag - 1]) && (lag === maxLag || corr[lag] >= corr[lag + 1]);
    if (peak && corr[lag] >= best * OCTAVE_GUARD) { period = lag; break; }
  }
  return { voicing: best, pitch: period ? rate / period : 0 };
}
