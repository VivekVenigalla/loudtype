// Turns how each word was spoken into type: loudness → size + weight,
// held length → width.
//
// LOUDNESS is measured against THIS speaker's normal level (learned from their
// first few normally-voiced words, then slowly tracked), in fixed dB steps.
// Fixed steps behave the same for everyone: a whisper is a whisper on any mic.
//
// WHISPERS are also caught by voicing: a whisper has no vocal-cord vibration,
// so a word that is mostly unvoiced reads as a whisper even if the mic is close.
//
// Only numbers are kept (time, dB, voicing), in short buffers that age out.

import { LEVELS } from './caption.js';

// dB relative to the speaker's normal level.
export const THRESHOLDS = { whisper: -10, soft: -5, loud: 5, shout: 10 };
export const CALIBRATE_WORDS = 6;
const UNVOICED_SHARE = 0.3;   // below this share of voiced frames → whisper
const VOICED_FRAME = 0.45;    // frame voicing at/above this counts as voiced
const WHISPER_MAX_DB = 4;     // an unvoiced word louder than normal+4 isn't a whisper
const NOISE_FLOOR_MIN_DB = -72;
const NOISE_WINDOW = 150;     // frames (~5 s) used to estimate the noise floor
const SILENCE_MARGIN_DB = 3;  // a word span this close to the noise floor has no word in it
const TRACK_RATE = 0.05;      // how fast "normal" follows the speaker after calibration
const HISTORY_SEC = 30;
const WORD_HISTORY = 80;
const HOLD_RATIO = 1.6;       // ms-per-letter vs. normal before a word stretches
const HOLD_MAX_RATIO = 3.2;   // ratio that reaches full width
const WDTH_MAX = 151;

export class Prosody {
  constructor() {
    this.frames = [];     // { t, db, voicing, speech }
    this.noiseDb = NOISE_FLOOR_MIN_DB;
    this.recentDbs = [];
    this.ref = null;      // speaker's normal word loudness (dB), null until calibrated
    this.calibDbs = [];
    this.wordPace = [];   // ms per letter
    this.last = null;     // last committed word's measurements (Director's View)
  }

  get calibrated() { return this.ref != null; }
  get calibration() { return this.calibrated ? 1 : this.calibDbs.length / CALIBRATE_WORDS; }

  recalibrate() {
    this.ref = null;
    this.calibDbs = [];
    this.wordPace = [];
  }

  push(t, db, voicing = 0) {
    // Noise floor = 10th percentile of the last ~5 s (speech always has gaps),
    // clamped so digital silence while the mic warms up can't drag it down.
    this.recentDbs.push(db);
    if (this.recentDbs.length > NOISE_WINDOW) this.recentDbs.shift();
    this.noiseDb = Math.max(NOISE_FLOOR_MIN_DB, quantile([...this.recentDbs].sort((a, b) => a - b), 0.1));
    const speech = db > this.noiseDb + 10;
    this.frames.push({ t, db, voicing, speech });
    while (this.frames.length && this.frames[0].t < t - HISTORY_SEC) this.frames.shift();
  }

  /** Current loudness vs. normal, in dB (null when silent or uncalibrated). */
  liveDelta() {
    const f = this.frames.at(-1);
    if (!f || !f.speech || !this.calibrated) return null;
    return f.db - this.ref;
  }

  /** Live meter value 0..1 (0.5 = normal) for the control panel. */
  liveLevel() {
    const f = this.frames.at(-1);
    if (!f || !f.speech) return 0;
    const ref = this.ref ?? -30;
    return clamp(0.5 + (f.db - ref) / 30, 0, 1);
  }

  /** Loudness (80th percentile dB) and voiced share of the speech in a span. */
  stats(start, end) {
    let span = this.frames.filter((f) => f.t >= start - 0.02 && f.t <= end + 0.02);
    const speech = span.filter((f) => f.speech);
    if (speech.length) span = speech;
    else if (!span.length) {
      const mid = (start + end) / 2;
      let best = null;
      for (const f of this.frames) if (!best || Math.abs(f.t - mid) < Math.abs(best.t - mid)) best = f;
      if (!best) return null;
      span = [best];
    }
    const dbs = span.map((f) => f.db).sort((a, b) => a - b);
    const voiced = span.filter((f) => f.voicing >= VOICED_FRAME).length / span.length;
    return { db: quantile(dbs, 0.8), voiced, speech: speech.length > 0 };
  }

  levelFor(st) {
    if (!st || !this.calibrated) return 'normal';
    const d = st.db - this.ref;
    if (d <= THRESHOLDS.whisper || (st.voiced < UNVOICED_SHARE && d < WHISPER_MAX_DB)) return 'whisper';
    if (d <= THRESHOLDS.soft) return 'soft';
    if (d >= THRESHOLDS.shout) return 'shout';
    if (d >= THRESHOLDS.loud) return 'loud';
    return 'normal';
  }

  /**
   * Instant styles for `n` words that just appeared in a partial transcript
   * (no timestamps yet). The recent audio window is split evenly between them.
   * Doesn't change the speaker's reference; committed words do that.
   */
  styleLive(start, end, n) {
    const out = [];
    const step = (end - start) / n;
    for (let i = 0; i < n; i++) {
      const st = this.stats(start + i * step, start + (i + 1) * step);
      const level = st?.speech ? this.levelFor(st) : 'normal';
      out.push({ level, ...LEVELS[level], wdth: 100 });
    }
    return out;
  }

  /** Style one committed word. start/end are AudioContext seconds. */
  styleWord(text, start, end) {
    const st = this.stats(start, end);
    // Timestamps can land a word on a pause. Room tone there isn't a whisper,
    // and must not teach calibration anything, so it stays normal and unmeasured.
    const silent = st && !st.speech && st.db < this.noiseDb + SILENCE_MARGIN_DB;
    const level = silent ? 'normal' : this.levelFor(st);

    if (silent) {
      this.last = { word: text, level, delta: null, voiced: st.voiced };
    } else if (st) {
      if (!this.calibrated) {
        // Learn "normal" only from voiced words, so an early whisper doesn't skew it.
        if (st.voiced >= UNVOICED_SHARE) this.calibDbs.push(st.db);
        if (this.calibDbs.length >= CALIBRATE_WORDS) this.ref = quantile([...this.calibDbs].sort((a, b) => a - b), 0.5);
      } else if (level === 'normal') {
        this.ref += (st.db - this.ref) * TRACK_RATE; // follow slow mic/posture changes
      }
      this.last = { word: text, level, delta: this.ref != null ? st.db - this.ref : null, voiced: st.voiced };
    }

    let wdth = 100;
    const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    if (letters && end > start) {
      const pace = ((end - start) * 1000) / letters;
      if (this.wordPace.length >= CALIBRATE_WORDS) {
        const ratio = pace / quantile([...this.wordPace].sort((a, b) => a - b), 0.5);
        if (ratio > HOLD_RATIO) {
          wdth = Math.round(100 + (WDTH_MAX - 100) * clamp((ratio - HOLD_RATIO) / (HOLD_MAX_RATIO - HOLD_RATIO), 0, 1));
        }
      }
      this.wordPace.push(pace);
      if (this.wordPace.length > WORD_HISTORY) this.wordPace.shift();
    }

    return { level, ...LEVELS[level], wdth };
  }
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
