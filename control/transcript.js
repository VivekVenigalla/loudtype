// Turns Scribe's partial and committed transcripts into caption line events
// for one session. No DOM and no globals: app.js wires it to the relay and the
// UI, and test/transcript.test.js drives it with fake events.
import { LEVELS } from './caption.js';

const splitWords = (text) => text.trim().split(/\s+/).filter(Boolean);
const plainWord = (word) => ({ word, level: 'normal', ...LEVELS.normal, wdth: 100 });

// Partials arrive ~1 s after the words were spoken. The real delay is learned
// from committed word timestamps (median of recent measurements).
const LAG_DEFAULT = 1.0;
const LIVE_MIN_WINDOW = 0.35;  // s of audio used to style a newly appeared word
const UNTIMED_WAIT_MS = 600;   // Scribe sends a plain commit, then a timestamped one
const DUPLICATE_MS = 3000;     // a plain commit repeating the last final line is ignored
const PROVISIONAL_WORDS = 4;   // tint a partial line once it has this many words

export class Transcript {
  /**
   * @param {object} deps
   * @param {import('./prosody.js').Prosody} deps.prosody
   * @param {(msg: object) => void} deps.send  caption events for the overlay
   * @param {(text: string, levels: string[]) => Promise<{emotion: string, confidence: number}> | null} deps.classify
   *        line emotion; returns null while the model is still loading
   * @param {() => string | null} deps.mood  mood forced by a hotkey, or null
   * @param {() => void} [deps.onStyled]  a committed line's words were just measured
   * @param {(line: object, info: object | null) => void} [deps.onFinal]  a line is finished
   * @param {() => number} [deps.clock]  ms
   */
  constructor({ prosody, send, classify, mood, onStyled = () => {}, onFinal = () => {}, clock = () => performance.now() }) {
    Object.assign(this, { prosody, send, classify, mood, onStyled, onFinal, clock });
    this.t0 = null;          // AudioContext time of Scribe's time 0 (set by the first audio chunk sent)
    this.origin = null;      // the first connection's t0: exported times count from here
    this.lineSeq = 0;
    this.current = null;     // the line being spoken: { id, text, styles, seenAt, lastAt, provisional, classifying }
    this.pendingCommit = null;
    this.lastFinal = { text: '', at: 0 };
    this.untimed = null;     // last line finalized without timestamps: { id, text, at, emotion, superseded }
    this.lags = [];          // measured partial delays (s)
    this.lines = [];         // finished lines with word timings, for export (memory only)
    this.closed = false;
  }

  close() {
    this.closed = true;
    clearTimeout(this.pendingCommit);
  }

  /**
   * Scribe reconnected: its clock restarts at the next audio chunk, and the
   * half-spoken line will never be committed. Calibration and lag are kept.
   */
  resync() {
    clearTimeout(this.pendingCommit);
    this.t0 = null;
    this.current = null;
    this.untimed = null;
  }

  /** Re-send the line being spoken (e.g. after a mood hotkey). */
  refresh() {
    if (this.current) this.emitPartial(this.current);
  }

  partialLag() {
    if (this.lags.length < 3) return LAG_DEFAULT;
    const sorted = [...this.lags].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  partial(text) {
    if (this.closed || !text.trim()) return;
    const now = this.prosody.frames.at(-1)?.t ?? 0; // latest audio actually measured
    if (!this.current) this.current = { id: ++this.lineSeq, text: '', styles: [], seenAt: [], lastAt: now - 0.8, provisional: 'neutral', classifying: false };
    const cur = this.current;
    cur.text = text;

    // Style new words immediately from the audio they most likely came from
    // (since the previous partial, minus recognizer lag), so a shout is big the
    // moment it appears instead of after the line commits.
    const words = splitWords(text);
    if (words.length > cur.styles.length) {
      const lag = this.partialLag();
      const end = now - lag;
      const start = Math.min(cur.lastAt - lag, end - LIVE_MIN_WINDOW);
      while (cur.seenAt.length < words.length) cur.seenAt.push(now);
      cur.styles.push(...this.prosody.styleLive(start, end, words.length - cur.styles.length));
    }
    cur.styles.length = words.length; // recognizer may drop words when revising
    cur.seenAt.length = words.length;
    cur.lastAt = now;
    this.emitPartial(cur);

    // Provisional tint, one classification at a time.
    if (!cur.classifying && words.length >= PROVISIONAL_WORDS) {
      const pending = this.classify(text, cur.styles.map((st) => st.level));
      if (!pending) return;
      cur.classifying = true;
      pending
        .then(({ emotion }) => {
          if (this.current !== cur) return;
          cur.provisional = emotion;
          this.emitPartial(cur);
        })
        .catch(() => {})
        .finally(() => { cur.classifying = false; });
    }
  }

  emitPartial(cur) {
    this.send({
      type: 'line', line: cur.id, final: false, provisional: true,
      emotion: this.mood() ?? cur.provisional, confidence: 0,
      words: splitWords(cur.text).map((word, i) => ({ word, ...(cur.styles[i] || plainWord(word)) })),
    });
  }

  // Scribe sends the plain commit and the timestamped one; prefer the timestamped.
  committed(text) {
    if (this.closed) return;
    if (!text.trim()) { this.current = null; return; }
    if (text === this.lastFinal.text && this.clock() - this.lastFinal.at < DUPLICATE_MS) return;
    clearTimeout(this.pendingCommit);
    this.pendingCommit = setTimeout(() => this.finalize(text, null), UNTIMED_WAIT_MS);
  }

  committedTimed({ text, words }) {
    if (this.closed) return;
    clearTimeout(this.pendingCommit);
    if (!text.trim() || !words.length) { this.current = null; return; }
    // Late: the plain commit already finalized this line without timings after
    // UNTIMED_WAIT_MS. Upgrade that line in place instead of adding a second one.
    const late = this.untimed;
    if (late && late.text === text && this.clock() - late.at < DUPLICATE_MS) {
      this.untimed = null;
      late.superseded = true; // its classification may still be running; drop its result
      return this.finalize(text, words, late);
    }
    return this.finalize(text, words);
  }

  async finalize(text, timedWords, late = null) {
    // A late upgrade belongs to an earlier line: leave the line being spoken alone.
    const cur = late ? null : this.current;
    const id = late?.id ?? cur?.id ?? ++this.lineSeq;
    const provisional = late?.emotion ?? cur?.provisional ?? 'neutral';
    // Learn the partial delay: when each word first showed up vs. when it ended.
    if (timedWords && this.t0 != null && cur) {
      cur.seenAt.slice(0, timedWords.length).forEach((seen, i) => {
        const lag = seen - (this.t0 + timedWords[i].end);
        if (lag > 0.05 && lag < 3) this.lags.push(lag);
      });
      this.lags.splice(0, Math.max(0, this.lags.length - 40));
    }
    if (!late) this.current = null;
    this.lastFinal = { text, at: this.clock() };
    const untimed = timedWords ? null : { id, text, at: this.clock(), emotion: 'neutral', superseded: false };
    if (untimed) this.untimed = untimed;

    let words;
    if (timedWords && this.t0 != null) {
      this.origin ??= this.t0;
      const shift = this.t0 - this.origin; // > 0 after a reconnect restarted Scribe's clock
      words = timedWords.map((w) => ({
        word: w.text.trim(),
        ...this.prosody.styleWord(w.text, this.t0 + w.start, this.t0 + w.end),
        start: w.start + shift, end: w.end + shift,
      })).filter((w) => w.word);
    } else {
      words = splitWords(text).map(plainWord); // no timing: unstyled, not exportable
    }
    this.onStyled();

    const base = { type: 'line', line: id, words };
    this.send({ ...base, final: false, provisional: true, emotion: this.mood() ?? provisional, confidence: 0 });

    let emotion = 'neutral', confidence = 0, info = null;
    const pending = this.classify(text, words.map((w) => w.level));
    if (pending) {
      try {
        info = await pending;
        ({ emotion, confidence } = info);
      } catch (err) { console.error(err); }
    }
    if (untimed?.superseded) return; // the timestamped version took over this line
    const forced = this.mood();
    if (forced) { emotion = forced; confidence = 1; }
    if (untimed) untimed.emotion = emotion;
    this.send({ ...base, final: true, provisional: false, emotion, confidence: +confidence.toFixed(2) });
    const line = { line: id, text, emotion, confidence, words };
    if (words.every((w) => typeof w.start === 'number')) this.lines.push(line);
    this.onFinal(line, info);
  }
}
