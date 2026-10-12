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
// VOICEPRINT: on a laptop mic someone a few metres away is only a few dB
// quieter, so level and pitch can't tell them apart. voiceprint.js compares
// each committed line with the voice calibration heard and sets `voice` while
// the line is styled: 'other' drops the whole line (whispered words included),
// 'match' and 'unsure' leave it to the level and pitch rules below.
//
// Only numbers are kept (time, dB, voicing, pitch), in short buffers that age out.

import { LEVELS } from './caption.js';
import { VOICED_FRAME } from './features.js';
import { toneFeatures, ToneBook } from './tone.js';

// dB relative to the speaker's normal level.
// soft/loud were ±5: normal speech wobbles up to +5.1, so ordinary words jumped size.
export const THRESHOLDS = { whisper: -10, soft: -6, loud: 6, shout: 8 }; // shout was +10: AirPods cap shouts at +8..+10
/** Sensitivity (control panel slider): thresholds are divided by it. 1 = THRESHOLDS; lower = calmer captions. */
export const SENSITIVITY = { min: 0.5, max: 1.5, default: 1 };
export const CALIBRATE_WORDS = 6;
const CALIB_CLUSTER_DB = 8;   // calibration learns the loudest voice: words this far under it are someone farther away
const CALIB_KEEP = 24;        // most recent calibration words kept
const UNVOICED_SHARE = 0.3;   // below this share of voiced frames → whisper
const WHISPER_MAX_DB = 4;     // an unvoiced word louder than normal+4 isn't a whisper
const NOISE_FLOOR_MIN_DB = -72;
const NOISE_WINDOW = 450;     // frames (~15 s) used to estimate the noise floor (5 s of nonstop talking pulled it up into the voice)
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
const GATE_MAX_BELOW_NORMAL_DB = 8; // ...and never higher than this under normal: the speaker's own words always pass
const GATE_UNCALIBRATED_DB = 5;  // before calibration: this over the room (a laptop mic's voice is only ~12 dB over it)
const GATE_UNVOICED_BELOW_NORMAL_DB = 22; // unvoiced frames (whispers) pass from here (laptop mic: whispers ~8 dB under normal, near the room)
const GATE_UNVOICED_ABOVE_NOISE_DB = 3;
const ENROLL_EXTRA_SEC = 3;   // after calibration, up to this much more of the speaker's voice goes into their voiceprint
const HOLD_RATIO = 1.6;       // ms-per-letter vs. normal before a word stretches
const HOLD_MAX_RATIO = 3.2;   // ratio that reaches full width
const WDTH_MAX = 151;

export class Prosody {
  constructor() {
    this.frames = [];     // { t, db, voicing, pitch, speech }
    this.noiseDb = NOISE_FLOOR_MIN_DB;
    this.recentDbs = [];
    this.ref = null;      // speaker's normal word loudness (dB), null until calibrated
    this.calibWords = []; // { db, pitch, start, end } of the voiced words calibration is learning from (voiceprint.js enrolls from their audio)
    this.calibDbs = [];
    this.pitch = null;    // main speaker's typical pitch (Hz), learned with `ref`; null if unknown
    this.calibPitches = [];
    this.enrollExtra = []; // { start, end } of the words right after calibration, until the voiceprint exists
    this.focus = true;    // ignore everyone but the main speaker
    this.sensitivity = SENSITIVITY.default;
    this.wordPace = [];   // ms per letter
    this.last = null;     // last committed word's measurements (Director's View)
    this.history = [];    // the last REPORT_WORDS of those (mic report)
    /** @type {import('./voiceprint-core.js').Verdict | null} the line being styled, set by transcript.js */
    this.voice = null;
    this.tones = new ToneBook(); // moods this speaker taught on purpose (tone.js)
  }

  get calibrated() { return this.ref != null; }
  get calibration() { return this.calibrated ? 1 : this.calibDbs.length / CALIBRATE_WORDS; }

  recalibrate() {
    this.ref = null;
    this.calibWords = [];
    this.calibDbs = [];
    this.pitch = null;
    this.calibPitches = [];
    this.enrollExtra = [];
    this.wordPace = [];
    this.history = [];
    this.tones = new ToneBook();
  }

  /**
   * The audio a voiceprint is learned from: the calibration words, plus the
   * main speaker's next few seconds (calibration needs only 6 words, ~1 s,
   * too little for a reliable voiceprint).
   */
  get enrollSpans() { return [...this.calibWords, ...this.enrollExtra]; }

  push(t, db, voicing = 0, pitch = 0) {
    // Noise floor = 10th percentile of the last ~15 s (speech always has gaps),
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

  /** THRESHOLDS at the current sensitivity (dB vs normal). */
  thresholds() {
    const k = Math.min(SENSITIVITY.max, Math.max(SENSITIVITY.min, this.sensitivity || 1));
    return { whisper: THRESHOLDS.whisper / k, soft: THRESHOLDS.soft / k, loud: THRESHOLDS.loud / k, shout: THRESHOLDS.shout / k };
  }

  levelFor(st) {
    if (!st || !this.calibrated) return 'normal';
    const d = st.db - this.ref;
    const th = this.thresholds();
    if (d <= th.whisper || (st.voiced < UNVOICED_SHARE && d < WHISPER_MAX_DB)) return 'whisper';
    if (st.voiced < BURST_MAX_VOICED) return 'normal'; // loud but no voice in it
    if (d <= th.soft) return 'soft';
    if (d >= th.shout) return 'shout';
    if (d >= th.loud) return 'loud';
    return 'normal';
  }

  /**
   * Why a measured word isn't the main speaker's, or null if it is theirs.
   * Only clearly voiced words can be someone else's: whispers (with or without
   * chatter under them) are the main speaker's, since nobody else's whisper reaches a close mic.
   */
  background(st) {
    if (!this.focus || !this.calibrated) return null;
    if (this.voice?.verdict === 'other') return `someone else (voiceprint ${this.voice.score.toFixed(2)})`;
    if (st.voiced < FOCUS_MIN_VOICED) return null;
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

  /** How a line sounded against this speaker's normal (tone.js), or null before calibration. */
  toneOf(start, end, words) {
    return this.calibrated ? toneFeatures(this, start, end, words) : null;
  }

  /** dBFS the audio gate needs before speech-to-text hears anything (-Infinity = gate off). */
  gateDb() {
    if (!this.focus) return -Infinity;
    if (!this.calibrated) return this.noiseDb + GATE_UNCALIBRATED_DB;
    return Math.min(this.ref - GATE_MAX_BELOW_NORMAL_DB, Math.max(this.noiseDb + GATE_ABOVE_NOISE_DB, this.ref - GATE_BELOW_NORMAL_DB));
  }

  /** The main speaker's normal level used by the gate null until known. */
  gateRef() { return this.ref; }

  /** dBFS an unvoiced (whisper-like) frame needs to open the gate; never above gateDb(). */
  gateUnvoicedDb() {
    const gate = this.gateDb();
    const ref = this.gateRef();
    if (gate === -Infinity || ref == null) return gate;
    return Math.min(gate, Math.max(this.noiseDb + GATE_UNVOICED_ABOVE_NOISE_DB, ref - GATE_UNVOICED_BELOW_NORMAL_DB));
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
      const background = st?.speech ? this.background(st) : null;
      const level = st?.speech && !background ? this.levelFor(st) : 'normal';
      out.push(background ? { level, ...LEVELS[level], wdth: 100, background } : { level, ...LEVELS[level], wdth: 100 });
    }
    return out;
  }

  remember(word) {
    this.last = { ...word, noiseDb: this.noiseDb };
    this.history.push(this.last);
    if (this.history.length > REPORT_WORDS) this.history.shift();
  }

  /**
   * Calibration step for one measured word. The person calibrating is next to
   * the mic, so the loudest voice heard is theirs: words more than 8 dB under
   * the loudest so far (chatter Scribe picked up before they spoke) are
   * dropped. `ref`/`pitch` are set once 6 voiced words agree, and unset again
   * if a louder voice takes over (only possible while calibration is running).
   */
  learn(st, start = 0, end = 0) {
    if (st.voiced < UNVOICED_SHARE) return; // whispers don't show the normal voice
    this.calibWords.push({ db: st.db, pitch: st.pitch, start, end });
    const top = Math.max(...this.calibWords.map((w) => w.db));
    this.calibWords = this.calibWords.filter((w) => w.db >= top - CALIB_CLUSTER_DB).slice(-CALIB_KEEP);
    this.calibDbs = this.calibWords.map((w) => w.db);
    this.calibPitches = this.calibWords.map((w) => w.pitch).filter((x) => x > 0);
    const ready = this.calibDbs.length >= CALIBRATE_WORDS;
    this.ref = ready ? quantile([...this.calibDbs].sort((a, b) => a - b), 0.5) : null;
    this.pitch = ready && this.calibPitches.length >= 3 ? quantile([...this.calibPitches].sort((a, b) => a - b), 0.5) : null;
  }

  /** Held-word width from ms per letter vs. this speaker's usual pace (and learn that pace). */
  widthFor(text, start, end) {
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
    return wdth;
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
        this.learn(st, start, end);
      } else {
        if (level === 'normal') {
          this.ref += (st.db - this.ref) * TRACK_RATE; // follow slow mic/posture changes
          if (st.pitch && this.pitch) this.pitch *= (st.pitch / this.pitch) ** TRACK_RATE;
        }
        // Until the voiceprint exists (voice is still null), the main speaker's voiced words add to it.
        const extra = this.enrollExtra.reduce((sum, w) => sum + w.end - w.start, 0);
        if (this.focus && this.voice == null && st.voiced >= UNVOICED_SHARE && extra < ENROLL_EXTRA_SEC) this.enrollExtra.push({ start, end });
      }
      this.remember(measured({ level, delta: this.ref != null ? st.db - this.ref : null }));
    }

    return { level, ...LEVELS[level], wdth: this.widthFor(text, start, end) };
  }
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
