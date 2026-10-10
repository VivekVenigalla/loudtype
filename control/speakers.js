// Who is talking. Two modes, chosen before Start:
//
//   Main speaker only (auto = false): plain Prosody. The first sentence
//     calibrates the main speaker; everyone else is filtered out.
//   Label everyone (auto = true, the default): no calibration. Every line is
//     captioned and labeled Speaker 1, 2, ... by voiceprint
//     (voiceprint-core.js diarize(), which sets `voice` while a line is
//     styled). Each speaker gets their own Prosody profile, so loudness is
//     measured against *their* normal, learned from their first few words.
//
// Profiles live in memory for this session only.
import { Prosody } from './prosody.js';
import { LEVELS } from './caption.js';

const plain = () => ({ level: /** @type {const} */ ('normal'), ...LEVELS.normal, wdth: 100 });

export class Speakers extends Prosody {
  constructor({ auto = true } = {}) {
    super();
    this.auto = auto;
    /** @type {Prosody[]} one per speaker heard (label-everyone mode) */
    this.profiles = [];
    this.activeIndex = 0;
    this.enrolling = false;
    if (auto) this.focus = false; // nobody is filtered out
  }

  /** Label-everyone mode: several profiles, captions carry a speaker. */
  get multi() { return this.auto; }

  /** No calibration step in label-everyone mode. */
  get calibration() { return this.auto ? 1 : super.calibration; }

  /** Speaker `from` turned out to be speaker `to` (their voiceprints converged). */
  mergeProfile(from, to) {
    if (this.activeIndex === from) this.activeIndex = to;
  }

  recalibrate() {
    super.recalibrate();
    if (this.auto) this.focus = false;
    this.profiles = [];
    this.activeIndex = 0;
  }

  /** Label everyone: speech-to-text hears everything. */
  gateDb() { return this.auto ? -Infinity : super.gateDb(); }

  /** The profile for a speaker index, created if this is the first we hear of them. */
  profile(i) {
    while (this.profiles.length <= i) {
      const created = new Prosody();
      created.focus = false;
      this.profiles.push(created);
    }
    const p = this.profiles[i];
    p.frames = this.frames;
    p.noiseDb = this.noiseDb;
    p.sensitivity = this.sensitivity;
    return p;
  }

  /** Each speaker teaches their own moods. */
  toneBookFor(speaker) { return this.auto ? this.profile(Math.max(0, (speaker ?? this.activeIndex + 1) - 1)).tones : this.tones; }

  /** Tone against the line's speaker's own normal (their profile). */
  toneOf(start, end, words, speaker) {
    if (!this.auto) return super.toneOf(start, end, words, speaker);
    const p = speaker ? this.profiles[speaker - 1] : null;
    return p?.calibrated ? p.toneOf(start, end, words) : null;
  }

  styleLive(start, end, n) {
    if (!this.auto) return super.styleLive(start, end, n);
    const p = this.profile(this.activeIndex);
    return Array.from({ length: n }, (_, i) => {
      const st = this.stats(start + ((end - start) * i) / n, start + ((end - start) * (i + 1)) / n);
      const level = st?.speech && p.calibrated ? p.levelFor(st) : 'normal';
      return { level, ...LEVELS[level], wdth: 100 };
    });
  }

  styleWord(text, start, end) {
    if (!this.auto) return super.styleWord(text, start, end);
    // The line's speaker (voiceprint); without one (model still loading, no timestamps) the last speaker.
    const index = this.voice?.best ?? this.activeIndex;
    const p = this.profile(index);
    this.activeIndex = index;
    const speaker = index + 1;
    const st = this.stats(start, end);
    if (!p.calibrated) {
      // Their first voiced words teach their normal loudness; until then they are shown at normal size.
      if (st && !(!st.speech && st.db < this.noiseDb + 3)) p.learn(st, start, end);
      p.widthFor(text, start, end); // their speaking pace, for held words later
      this.remember({ word: text, ...st, level: 'normal', delta: null, speaker });
      return { ...plain(), speaker };
    }
    const style = p.styleWord(text, start, end);
    if (st && p.last) this.remember({ ...p.last, speaker });
    return { ...style, speaker };
  }
}
