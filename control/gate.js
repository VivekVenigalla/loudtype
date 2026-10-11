// Background gate for the speech-to-text stream (16 kHz). Audio quieter than
// the threshold (set from the main speaker's level) is replaced by silence, so
// chatter around the mic is never transcribed. The stream is delayed by the
// lookahead so the gate opens just before a word starts, and it stays open for
// the hangover after the last loud frame so word endings aren't clipped.
// Output length equals input length, so Scribe's clock stays continuous;
// pcm-worklet.js subtracts `delaySec` from chunk times. Pure, so tests drive it.
//
// Whispers have no voice, so they can sit far below the main speaker's normal
// (on a laptop mic, barely over the room). The worklet reports each unvoiced
// frame with unvoiced(db); those open the gate from a lower threshold for a
// short hangover. Someone else's voiced speech still needs the main threshold.

export class Gate {
  constructor({ rate = 16000, frameSec = 0.02, lookaheadSec = 0.15, hangoverSec = 0.35, unvoicedHangoverSec = 0.15, fadeSec = 0.01 } = {}) {
    this.rate = rate;
    this.frameLen = Math.round(rate * frameSec);
    this.delay = Math.round(rate * lookaheadSec);
    this.hangover = Math.round(rate * hangoverSec);
    this.unvoicedHangover = Math.round(rate * unvoicedHangoverSec);
    this.fadeStep = 1 / Math.max(1, Math.round(rate * fadeSec));
    this.line = new Float32Array(this.delay); // delay line
    this.pos = 0;
    this.n = 0;                   // input samples seen
    this.sum = 0;                 // energy of the frame being measured
    this.count = 0;
    this.openUntil = -1;          // last output sample index that passes
    this.gain = 0;
    this.thresholdDb = -Infinity; // passes everything until a threshold is set
    this.unvoicedDb = -Infinity;
  }

  get delaySec() { return this.delay / this.rate; }

  /**
   * dBFS (20 ms RMS) a frame needs to open the gate; -Infinity = gate off.
   * `unvoicedDb`: what an unvoiced (whisper-like) frame needs, see unvoiced().
   */
  setThreshold(db, unvoicedDb = db) {
    this.thresholdDb = db;
    this.unvoicedDb = Math.min(db, unvoicedDb);
  }

  /** The audio just pushed had an unvoiced frame at `db` (measured by the worklet). */
  unvoiced(db) {
    if (db >= this.unvoicedDb) this.openUntil = Math.max(this.openUntil, this.n + this.unvoicedHangover);
  }

  /** One input sample in, one delayed (and possibly silenced) sample out. */
  push(x) {
    const n = this.n++;
    this.sum += x * x;
    if (++this.count === this.frameLen) {
      const db = 10 * Math.log10(this.sum / this.frameLen + 1e-20);
      // Output lags input by `delay`, so opening now still lets through the
      // (delay - frame) samples before this frame started.
      if (db >= this.thresholdDb) this.openUntil = Math.max(this.openUntil, n + this.hangover);
      this.sum = 0;
      this.count = 0;
    }
    const out = this.line[this.pos];
    this.line[this.pos] = x;
    this.pos = (this.pos + 1) % this.delay;
    const m = n - this.delay; // index of `out` in the input stream
    const target = m >= 0 && m <= this.openUntil ? 1 : 0;
    this.gain += Math.max(-this.fadeStep, Math.min(this.fadeStep, target - this.gain)); // 10 ms fades, no clicks
    return m < 0 ? 0 : out * this.gain;
  }
}
