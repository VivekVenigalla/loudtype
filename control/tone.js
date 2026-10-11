// Tone of voice for a caption line, against THIS speaker's normal: how
// loud, how high, how much the pitch moves, how fast. Pure (no DOM, no model),
// shared by the app and scripts/eval-emotion-voice.mjs.
import { decide, fuse } from './emotion-core.js';

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
export function decideEmotion(scores, text, features, voiceScores, minConfidence) {
  return fuse(decide(scores, text, toneEnergy(features), minConfidence), voiceScores);
}

/**
 * "Teach it your tones": a few lines the speaker says on purpose in each
 * mood (prompt cards: the same boring sentence happy, angry, sad), kept as
 * that person's own reference. A later line whose voice is clearly closer to
 * one taught mood than to their neutral voice and to the other moods takes
 * that mood, even when its words are neutral. Generic voice-emotion models
 * didn't hear tone on neutral words (tried two, 2026-10-10); one person's own
 * range is far easier to tell apart. Memory only, per speaker, per session.
 */
export const TONE_BOOK = {
  KEEP: 3,             // samples kept per mood (the last ones)
  SCALE: { loud: 4, pitch: 3, range: 4, rate: 1.2 }, // what counts as "1 unit" of difference
  VS_NEUTRAL: 0.6,     // the match must be this much closer than neutral is
  VS_OTHER: 0.8,       // ...and than the next-closest mood
  MIN_SPREAD: 1.5,     // a taught mood only counts if it sounded this different from their neutral voice
                       // (ElevenLabs' acted moods on neutral words were ~0.5-1 apart: too close to tell, so ignored)
};
const DIMS = /** @type {const} */ (['loud', 'pitch', 'range', 'rate']);

export class ToneBook {
  constructor() {
    /** @type {Map<string, ReturnType<typeof toneFeatures>[]>} mood → samples */
    this.samples = new Map();
  }

  /** Moods taught so far (besides neutral). */
  get taught() { return [...this.samples.keys()].filter((e) => e !== 'neutral'); }

  /** Taught moods that sound clearly different from this speaker's neutral voice (the ones match() uses). */
  get usable() { const p = this.prototypes(); return this.taught.filter((e) => this.distance(p.get(e), p.get('neutral')) >= TONE_BOOK.MIN_SPREAD); }

  /** Is this mood clearly different from their neutral voice? (feedback for the teach card) */
  isUsable(emotion) { return this.usable.includes(emotion); }

  prototypes() {
    const mean = (list) => Object.fromEntries(DIMS.map((d) => [d, list.reduce((a, x) => a + x[d], 0) / list.length]));
    const protos = new Map([...this.samples].map(([e, list]) => [e, mean(list)]));
    // Their neutral voice: taught, or else their calibrated normal (0 dB, 0 st) at a typical range and their pace.
    if (!protos.has('neutral')) {
      const all = [...this.samples.values()].flat();
      protos.set('neutral', { loud: 0, pitch: 0, range: TONE.RANGE_NORMAL, rate: all.length ? all.reduce((a, x) => a + x.rate, 0) / all.length : 3 });
    }
    return protos;
  }

  distance(f, p) { return Math.sqrt(DIMS.reduce((a, d) => a + ((f[d] - p[d]) / TONE_BOOK.SCALE[d]) ** 2, 0)); }

  teach(emotion, f) {
    if (!f) return false;
    const list = this.samples.get(emotion) ?? [];
    list.push(f);
    if (list.length > TONE_BOOK.KEEP) list.shift();
    this.samples.set(emotion, list);
    return true;
  }

  /** @returns {{ emotion: string, confident: boolean, distance: number } | null} */
  match(f) {
    const usable = this.usable;
    if (!f || !usable.length) return null;
    const protos = this.prototypes();
    const ranked = ['neutral', ...usable].map((e) => ({ emotion: e, distance: this.distance(f, protos.get(e)) })).sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    if (best.emotion === 'neutral') return { ...best, confident: false };
    const neutral = ranked.find((r) => r.emotion === 'neutral').distance;
    const next = ranked.find((r) => r.emotion !== best.emotion && r.emotion !== 'neutral')?.distance ?? Infinity;
    const confident = best.distance <= TONE_BOOK.VS_NEUTRAL * neutral && best.distance <= TONE_BOOK.VS_OTHER * next;
    return { ...best, confident };
  }
}
