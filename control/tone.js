// Tone of voice for a caption line, against THIS speaker's normal: how
// loud, how high, how much the pitch moves, how fast. Pure (no DOM, no model),
// shared by the app and scripts/eval-emotion-voice.mjs.
import { decide } from './emotion-core.js';

const VOICED = 0.45;

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const st = (hz, ref) => 12 * Math.log2(hz / ref);

/**
 * @param {import('./prosody.js').Prosody} p  the speaker's profile (calibrated: ref = normal dB, pitch = normal Hz)
 * @param {number} start  @param {number} end  AudioContext seconds  @param {number} words
 * @returns {{ loud: number, pitch: number, range: number, voiced: number, rate: number } | null}
 *   loud: dB vs normal · pitch: semitones vs their normal pitch · range: semitones between the
 *   line's low and high pitch (p10-p90) · voiced: share of voiced speech frames · rate: words per second
 */
export function toneFeatures(p, start, end, words) {
  const frames = p.frames.filter((f) => f.t >= start && f.t <= end && f.speech);
  if (frames.length < 5 || p.ref == null) return null;
  const dbs = frames.map((f) => f.db).sort((a, b) => a - b);
  const pitches = frames.filter((f) => f.voicing >= VOICED && f.pitch > 0).map((f) => f.pitch).sort((a, b) => a - b);
  const ref = p.pitch || quantile(pitches, 0.5) || 1;
  return {
    loud: quantile(dbs, 0.8) - p.ref,
    pitch: pitches.length >= 3 ? st(quantile(pitches, 0.5), ref) : 0,
    range: pitches.length >= 3 ? st(quantile(pitches, 0.9), quantile(pitches, 0.1)) : 0,
    voiced: pitches.length / frames.length,
    rate: words / Math.max(0.3, end - start),
  };
}

/**
 * Voice energy 0..1 (0.5 = this speaker's normal) from how the line sounded:
 * raised pitch is the strongest sign of excitement or anger, then loudness
 * and a wide pitch range; low, flat, quiet speech is calm or sad.
 * Tuned on scripts/eval-emotion-voice.mjs voice A, checked on voice B.
 */
export function toneEnergy(f) {
  if (!f) return 0.5;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const e = 0.5
    + TONE.PITCH * clamp(f.pitch, -6, 10)
    + TONE.LOUD * clamp(f.loud, -10, 12)
    + TONE.RANGE * clamp(f.range - TONE.RANGE_NORMAL, -6, 8);
  return clamp(e, 0, 1);
}
export const TONE = { PITCH: 0.05, LOUD: 0.03, RANGE: 0.015, RANGE_NORMAL: 9 };

/**
 * Line emotion: valence (positive/negative/neutral) from the words, energy from
 * the voice (toneEnergy) with a nudge from the words. Neutral words stay white
 * even when spoken with feeling: the voice alone can't say happy vs. angry
 * reliably, and a white line beats a wrong color.
 */
export function decideEmotion(scores, text, features, _voiceScores, minConfidence) {
  return decide(scores, text, toneEnergy(features), minConfidence);
}
