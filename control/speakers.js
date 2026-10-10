// Session-only acoustic profiles. Pitch and level are heuristics, not voiceprints:
// similar voices, unvoiced words and overlapping speech cannot be identified reliably.
import { Prosody } from './prosody.js';
import { LEVELS } from './caption.js';

const plain = () => ({ level: /** @type {const} */ ('normal'), ...LEVELS.normal, wdth: 100 });

export class Speakers extends Prosody {
  constructor(count = 1) {
    super();
    if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw new Error('Choose a whole number of speakers from 1 to 32.');
    this.profiles = Array.from({ length: count }, () => new Prosody());
    this.enrolling = count > 1;
    this.enrollmentIndex = 0;
    this.activeIndex = 0;
    this.boundary = -Infinity;
    this.requireTimed = count > 1;
    this.filterWordsIndividually = count > 1;
    this.suppressCaptions = this.enrolling;
  }

  get multi() { return this.profiles.length > 1; }
  get enrollmentReady() {
    const p = this.profiles[this.enrollmentIndex];
    return p.calibrated && p.pitch != null;
  }
  get calibration() {
    if (!this.multi) return super.calibration;
    if (!this.enrolling) return 1;
    const p = this.profiles[this.enrollmentIndex];
    // A profile without pitch isn't ready, even if its loudness is learned.
    return (this.enrollmentIndex + Math.min(p.calibration, p.pitch ? 1 : 0.95)) / this.profiles.length;
  }

  advance() {
    if (!this.enrolling || !this.enrollmentReady) return false;
    this.boundary = this.frames.at(-1)?.t ?? 0;
    if (this.enrollmentIndex + 1 < this.profiles.length) this.enrollmentIndex++;
    else { this.enrolling = false; this.suppressCaptions = false; }
    return true;
  }

  recalibrate() {
    super.recalibrate();
    for (const p of this.profiles) p.recalibrate();
    this.enrollmentIndex = this.activeIndex = 0;
    this.enrolling = this.multi;
    this.suppressCaptions = this.enrolling;
    this.boundary = this.frames.at(-1)?.t ?? 0;
  }

  /** Closest plausible calibrated profile. Unknown voiced speech is rejected. */
  match(st) {
    if (!st || (!st.speech && st.db < this.noiseDb + 3)) return null;
    // No pitch in whispers/consonants: retain continuity, without claiming identity.
    if (st.voiced < 0.5 || !st.pitch) return this.activeIndex;
    let best = null, distance = Infinity;
    this.profiles.forEach((p, i) => {
      if (!p.calibrated || !p.pitch) return;
      const semis = 12 * Math.log2(st.pitch / p.pitch);
      if (this.focus && (st.db < p.ref - 12 || semis < -5 || semis > 7)) return;
      const score = Math.abs(semis) + Math.abs(st.db - p.ref) / 12;
      if (score < distance) { best = i; distance = score; }
    });
    return best;
  }

  gateDb() {
    if (!this.multi) return super.gateDb();
    if (!this.focus) return -Infinity;
    if (this.enrolling) return this.noiseDb + 10;
    // The quieter enrolled speaker must still reach Scribe.
    return Math.max(this.noiseDb + 6, Math.min(...this.profiles.map((p) => p.ref)) - 18);
  }

  styleLive(start, end, n) {
    if (!this.multi) return super.styleLive(start, end, n);
    // In focused multi-speaker mode wait for real word times rather than leak
    // unidentified partials onto the overlay from an approximate audio window.
    return Array.from({ length: n }, (_, i) => {
      const st = this.stats(start + (end - start) * i / n, start + (end - start) * (i + 1) / n);
      const index = this.match(st);
      const level = index == null ? 'normal' : this.profiles[index].levelFor(st);
      return { level, ...LEVELS[level], wdth: 100 };
    });
  }

  styleWord(text, start, end) {
    if (!this.multi) return super.styleWord(text, start, end);
    if (start <= this.boundary) return { ...plain(), background: 'before the current calibration step' };
    const st = this.stats(start, end);
    const index = this.enrolling ? this.enrollmentIndex : this.match(st);
    if (index == null) {
      this.remember({ word: text, ...st, level: 'normal', delta: null, background: 'no enrolled acoustic profile matched' });
      return { ...plain(), background: 'no enrolled acoustic profile matched' };
    }
    const p = this.profiles[index];
    p.frames = this.frames;
    p.noiseDb = this.noiseDb;
    p.focus = false; // matching above already checked every enrolled profile
    // Freeze enrollment once ready; the rest of that phrase is still speaker N.
    if (this.enrolling && this.enrollmentReady) return plain();
    const style = p.styleWord(text, start, end);
    // Continue learning pitch if the first six voiced words lacked enough pitch measurements.
    if (this.enrolling && p.calibrated && !p.pitch && st?.speech && st.pitch && st.voiced >= 0.5) {
      p.calibPitches.push(st.pitch);
      if (p.calibPitches.length >= 3) p.pitch = [...p.calibPitches].sort((a, b) => a - b)[Math.floor(p.calibPitches.length / 2)];
    }
    this.activeIndex = index;
    this.ref = p.ref;
    this.pitch = p.pitch;
    if (p.last) this.remember({ ...p.last, speaker: index + 1 });
    return { ...style, speaker: index + 1 };
  }
}
