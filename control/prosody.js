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
// MAIN SPEAKER: the voice it calibrated on (the judge after "New judge") is the
// only one captioned. Calibration also learns their pitch. On a close mic
// anyone else is clearly quieter, so a voiced word that is quieter than the
// main speaker's normal AND not at their pitch is someone else and is dropped;
// gateDb() also tells the audio gate (gate.js) to silence anything quieter
// than the main speaker's whispers before speech-to-text hears it. Loud bursts
// with no voice in them (claps, bumps, breath on the mic) never count as loud.
//
// Only numbers are kept (time, dB, voicing, pitch), in short buffers that age out.

import { LEVELS } from './caption.js';

// dB relative to the speaker's normal level.
export const THRESHOLDS = { whisper: -10, soft: -5, loud: 5, shout: 8 }; // shout was +10: AirPods cap shouts at +8..+10
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
const REPORT_WORDS = 40;      // measured words kept for the mic report
const BURST_MAX_VOICED = 0.15; // louder than normal but this unvoiced: a clap or bump, not a voice
// Main-speaker focus
const FOCUS_MIN_VOICED = 0.5; // only clearly voiced words can be ruled someone else (chatter under a whisper adds some voicing)
const NEAR_NORMAL_DB = -3;    // at or above (normal - 3 dB) it's the main speaker: nobody else is that loud on a close mic
const QUIET_VOICED_DB = -12;  // a clearly voiced word this far under normal is someone else, at any pitch
                              // (the main speaker's quiet words are whispered, so unvoiced)
const PITCH_BELOW_ST = 5;     // pitch range (semitones around the main speaker's) that still counts as them
const PITCH_ABOVE_ST = 7;
const GATE_BELOW_NORMAL_DB = 18; // the audio gate passes down to normal - 18 dB (whispers measured down to -15)
const GATE_ABOVE_NOISE_DB = 6;   // ...but never lower than this over the room noise
const HOLD_RATIO = 1.6;       // ms-per-letter vs. normal before a word stretches
const HOLD_MAX_RATIO = 3.2;   // ratio that reaches full width
const WDTH_MAX = 151;

export class Prosody {
  constructor() {
    this.frames = [];     // { t, db, voicing, pitch, speech }
    this.noiseDb = NOISE_FLOOR_MIN_DB;
    this.recentDbs = [];
    this.ref = null;      // speaker's normal word loudness (dB), null until calibrated
    this.calibDbs = [];
    this.pitch = null;    // main speaker's typical pitch (Hz), learned with `ref`; null if unknown
    this.calibPitches = [];
    this.focus = true;    // ignore everyone but the main speaker
    this.wordPace = [];   // ms per letter
    this.last = null;     // last committed word's measurements (Director's View)
    this.history = [];    // the last REPORT_WORDS of those (mic report)
    this.suppressCaptions = false;
    this.requireTimed = false;
    this.filterWordsIndividually = false;
  }

  get calibrated() { return this.ref != null; }
  get calibration() { return this.calibrated ? 1 : this.calibDbs.length / CALIBRATE_WORDS; }

  recalibrate() {
    this.ref = null;
    this.calibDbs = [];
    this.pitch = null;
    this.calibPitches = [];
    this.wordPace = [];
    this.history = [];
  }

  push(t, db, voicing = 0, pitch = 0) {
    // Noise floor = 10th percentile of the last ~5 s (speech always has gaps),
    // clamped so digital silence while the mic warms up can't drag it down.
    this.recentDbs.push(db);
    if (this.recentDbs.length > NOISE_WINDOW) this.recentDbs.shift();
    this.noiseDb = Math.max(NOISE_FLOOR_MIN_DB, quantile([...this.recentDbs].sort((a, b) => a - b), 0.1));
    const speech = db > this.noiseDb + 10;
    this.frames.push({ t, db, voicing, pitch, speech });
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

  /** Loudness (80th percentile dB), voiced share and pitch (median Hz of voiced frames, 0 = unknown) of the speech in a span. */
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
    const voicedFrames = span.filter((f) => f.voicing >= VOICED_FRAME);
    const pitches = voicedFrames.map((f) => f.pitch).filter((p) => p > 0).sort((a, b) => a - b);
    return {
      db: quantile(dbs, 0.8),
      voiced: voicedFrames.length / span.length,
      pitch: pitches.length >= 2 ? quantile(pitches, 0.5) : 0,
      speech: speech.length > 0,
    };
  }

  levelFor(st) {
    if (!st || !this.calibrated) return 'normal';
    const d = st.db - this.ref;
    if (d <= THRESHOLDS.whisper || (st.voiced < UNVOICED_SHARE && d < WHISPER_MAX_DB)) return 'whisper';
    if (st.voiced < BURST_MAX_VOICED) return 'normal'; // loud but no voice in it
    if (d <= THRESHOLDS.soft) return 'soft';
    if (d >= THRESHOLDS.shout) return 'shout';
    if (d >= THRESHOLDS.loud) return 'loud';
    return 'normal';
  }

  /**
   * Why a measured word isn't the main speaker's, or null if it is theirs.
   * Only clearly voiced words can be someone else's: whispers (with or without
   * chatter under them) are the main speaker's, since nobody else's whisper reaches a close mic.
   */
  background(st) {
    if (!this.focus || !this.calibrated || st.voiced < FOCUS_MIN_VOICED) return null;
    const d = st.db - this.ref;
    if (d >= NEAR_NORMAL_DB) return null;
    if (d < QUIET_VOICED_DB) return `someone else (voiced but ${d.toFixed(1)} dB under your normal)`;
    if (st.pitch && this.pitch) {
      const semis = 12 * Math.log2(st.pitch / this.pitch);
      if (semis < -PITCH_BELOW_ST || semis > PITCH_ABOVE_ST) {
        return `someone else (${Math.round(st.pitch)} Hz vs your ${Math.round(this.pitch)} Hz, ${d.toFixed(1)} dB)`;
      }
    }
    return null;
  }

  /** dBFS the audio gate needs before speech-to-text hears anything (-Infinity = gate off). */
  gateDb() {
    if (!this.focus) return -Infinity;
    if (!this.calibrated) return this.noiseDb + 10; // until then: anything that counts as speech
    return Math.max(this.noiseDb + GATE_ABOVE_NOISE_DB, this.ref - GATE_BELOW_NORMAL_DB);
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
      const level = st?.speech && !this.background(st) ? this.levelFor(st) : 'normal';
      out.push({ level, ...LEVELS[level], wdth: 100 });
    }
    return out;
  }

  remember(word) {
    this.last = { ...word, noiseDb: this.noiseDb };
    this.history.push(this.last);
    if (this.history.length > REPORT_WORDS) this.history.shift();
  }

  /** Style one committed word. start/end are AudioContext seconds. */
  styleWord(text, start, end) {
    const st = this.stats(start, end);
    // Timestamps can land a word on a pause. Room tone there isn't a whisper,
    // and must not teach calibration anything, so it stays normal and unmeasured.
    const silent = st && !st.speech && st.db < this.noiseDb + SILENCE_MARGIN_DB;
    const measured = (more) => ({ word: text, db: st.db, voiced: st.voiced, pitch: Math.round(st.pitch), speech: st.speech, silent: false, ...more });

    if (silent) {
      this.remember({ ...measured({ level: 'normal', delta: null, speech: false, silent: true }) });
    } else if (st) {
      // Someone else: dropped by the transcript; it teaches nothing (level, pitch or pace).
      const background = this.background(st);
      if (background) {
        this.remember(measured({ level: 'normal', delta: st.db - this.ref, background }));
        return { level: 'normal', ...LEVELS.normal, wdth: 100, background };
      }
    }
    const level = silent ? 'normal' : this.levelFor(st);

    if (st && !silent) {
      if (!this.calibrated) {
        // Learn "normal" only from voiced words, so an early whisper doesn't skew it.
        if (st.voiced >= UNVOICED_SHARE) {
          this.calibDbs.push(st.db);
          if (st.pitch) this.calibPitches.push(st.pitch);
        }
        if (this.calibDbs.length >= CALIBRATE_WORDS) {
          this.ref = quantile([...this.calibDbs].sort((a, b) => a - b), 0.5);
          this.pitch = this.calibPitches.length >= 3 ? quantile([...this.calibPitches].sort((a, b) => a - b), 0.5) : null;
        }
      } else if (level === 'normal') {
        this.ref += (st.db - this.ref) * TRACK_RATE; // follow slow mic/posture changes
        if (st.pitch && this.pitch) this.pitch *= (st.pitch / this.pitch) ** TRACK_RATE;
      }
      this.remember(measured({ level, delta: this.ref != null ? st.db - this.ref : null }));
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
