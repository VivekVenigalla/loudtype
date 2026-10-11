// Turns Scribe's partial and committed transcripts into caption line events
// for one session. No DOM and no globals: app.js wires it to the relay and the
// UI, and test/transcript.test.js drives it with fake events.
import { LEVELS } from './caption.js';

const TURN_GAP_SEC = 0.25; // a pause this long inside a committed line may be a change of speaker
const TURN_MIN_SEC = 1.0;  // shorter stretches can't be told apart by voiceprint

/**
 * Split a committed line's words into turns: at its longest pause first (a
 * change of speaker usually leaves a longer gap than pauses within a turn),
 * then again inside each side, but only where both sides are long enough to
 * identify by voiceprint.
 */
export function splitTurns(words) {
  const len = (a, b) => words[b].end - words[a].start; // words a..b inclusive
  let cut = -1, gap = TURN_GAP_SEC;
  for (let i = 1; i < words.length; i++) {
    const g = words[i].start - words[i - 1].end;
    if (g >= gap && len(0, i - 1) >= TURN_MIN_SEC && len(i, words.length - 1) >= TURN_MIN_SEC) { cut = i; gap = g; }
  }
  return cut < 0 ? [words] : [...splitTurns(words.slice(0, cut)), ...splitTurns(words.slice(cut))];
}

/** The speaker who said most of a line's words (1-based), or null when words carry none. */
function lineSpeaker(words) {
  const counts = new Map();
  for (const w of words) if (w.speaker) counts.set(w.speaker, (counts.get(w.speaker) || 0) + 1);
  let best = null, n = 0;
  for (const [sp, c] of counts) if (c > n) { best = sp; n = c; }
  return best;
}

const splitWords = (text) => text.trim().split(/\s+/).filter(Boolean);
const plainWord = (word) => ({ word, level: 'normal', ...LEVELS.normal, wdth: 100 });

// Partials arrive ~1 s after the words were spoken. The real delay is learned
// from committed word timestamps (median of recent measurements).
const LAG_DEFAULT = 1.0;
const LIVE_MIN_WINDOW = 0.35;  // s of audio used to style a newly appeared word
const UNTIMED_WAIT_MS = 600;   // Scribe sends a plain commit, then a timestamped one
const DUPLICATE_MS = 3000;     // a plain commit repeating the last final line is ignored
const PROVISIONAL_WORDS = 4;   // tint a partial line once it has this many words
const LINE_LEAD = 1.0;         // s of audio before a line's first partial that may hold its first words
const LIVE_TAIL = 0.2;         // s past the lag-corrected end, in case the lag estimate is long

export class Transcript {
  /**
   * @param {object} deps
   * @param {import('./prosody.js').Prosody} deps.prosody
   * @param {(msg: import('./caption.js').LineEvent) => void} deps.send  caption events for the overlay
   * @param {(text: string, levels: string[], tone?: ReturnType<import('./tone.js').toneFeatures>, taught?: ReturnType<import('./tone.js').ToneBook['match']>, span?: { start: number, end: number } | null) => Promise<{emotion: import('./caption.js').Emotion, confidence: number}> | null} deps.classify
   *        line emotion (tone: how the committed line sounded; taught: its closest mood the speaker taught); null while the model loads
   * @param {() => import('./caption.js').Emotion | null} deps.mood  mood forced by a hotkey, or null
   * @param {(voice: import('./voiceprint-core.js').Verdict | null) => void} [deps.onStyled]  a committed line's words were just measured (with its voiceprint verdict)
   * @param {(line: object, info: object | null, tone: object | null) => void} [deps.onFinal]  a line is finished (tone: how it sounded, for teaching moods)
   * @param {(start: number, end: number, live?: boolean) => Promise<import('./voiceprint-core.js').Verdict | null> | null} [deps.identify]
   * @param {(start: number, end: number) => Promise<{ text: string, words: { text: string, start: number, end: number }[], offset: number } | null> | null} [deps.refine]
   *   second-pass transcript of the line's audio (batch Scribe v2); word times relative to `offset` (AudioContext time)
   *        whose voice is in that audio (AudioContext s; live = a partial, only guess); null/omitted = no voiceprints
   * @param {() => number} [deps.clock]  ms
   */
  constructor({ prosody, send, classify, mood, onStyled = () => {}, onFinal = () => {}, identify = null, refine = null, clock = () => performance.now() }) {
    this.prosody = prosody;
    this.send = send;
    this.classify = classify;
    this.mood = mood;
    this.onStyled = onStyled;
    this.onFinal = onFinal;
    this.identify = identify;
    this.refine = refine;
    this.clock = clock;
    this.t0 = null;          // AudioContext time of Scribe's time 0 (set by the first audio chunk sent)
    this.origin = null;      // the first connection's t0: exported times count from here
    this.lineSeq = 0;
    this.current = null;     // the line being spoken: { id, text, styles, seenAt, lastAt, provisional, classifying }
    this.pendingCommit = null;
    this.lastFinal = { text: '', at: 0 };
    this.untimed = null;     // last line finalized without timestamps: { id, text, at, emotion, superseded }
    this.lags = [];          // measured partial delays (s)
    this.lines = [];         // finished lines with word timings, for export (memory only)
    this.heard = [];         // last lines as Scribe committed them vs. what was captioned (mic report: where words go missing)
    this.lastSpeaker = null; // label-everyone mode: the last finished line's speaker (1-based)
    this.closed = false;
    this.generation = 0;
  }

  /** Discard a calibration step's pending text, keeping the audio/session clock. */
  resetCaption() {
    this.generation++;
    clearTimeout(this.pendingCommit);
    this.current = null;
    this.untimed = null;
    this.lastFinal = { text: '', at: 0 };
    this.lastSpeaker = null;
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
    if (!this.current) {
      this.current = {
        id: ++this.lineSeq, text: '', styles: [], seenAt: [], lastAt: now - 0.8, provisional: 'neutral', classifying: false,
        audioStart: now - this.partialLag() - LINE_LEAD, voice: undefined, checking: false,
      };
    }
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
    this.checkVoice(cur, now);
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

  /**
   * Voiceprint of the line so far (one check at a time, ~20 ms). Live words
   * show at once (waiting for the check made the speaker's own words late);
   * 'other' takes them off screen. The committed line is checked again in full.
   */
  checkVoice(cur, now) {
    if (!this.identify || !(this.prosody.focus || this.prosody.multi) || cur.checking) return;
    const lag = this.partialLag();
    const pending = this.identify(cur.audioStart, now - lag + LIVE_TAIL, true);
    if (!pending) { cur.voice = null; return; }
    cur.checking = true;
    pending
      .catch(() => null)
      .then((voice) => {
        cur.checking = false;
        if (this.current !== cur) return;
        cur.voice = voice;
        this.emitPartial(cur);
      });
  }

  emitPartial(cur) {
    if (this.prosody.suppressCaptions || (this.prosody.requireTimed && this.prosody.focus)) return;
    const focus = this.prosody.focus;
    const stranger = focus && cur.voice?.verdict === 'other';
    const words = splitWords(cur.text)
      .map((word, i) => ({ word, ...(cur.styles[i] || plainWord(word)) }))
      // Live words whose audio sounds like someone else (level/pitch) wait for the committed line.
      .filter((w) => !(focus && w.background))
      .map(({ background, ...w }) => w);
    // Label everyone: the live guess of who is talking, else whoever spoke last.
    const guess = cur.voice?.verdict === 'match' ? cur.voice.best + 1 : this.lastSpeaker ?? 1; // the first voice heard is S1
    this.send({
      type: 'line', line: cur.id, final: false, provisional: true,
      emotion: this.mood() ?? cur.provisional, confidence: 0,
      words: stranger ? [] : words,
      ...(this.prosody.multi && guess ? { speaker: guess } : {}),
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
    const suppress = this.prosody.suppressCaptions;
    const generation = this.generation;
    const rawText = text;
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

    // Better words: the line's audio again through the batch model. Keeps the realtime words if it fails.
    if (timedWords && this.t0 != null && this.refine) {
      const t0 = this.t0;
      const pending = this.refine(t0 + timedWords[0].start, t0 + timedWords.at(-1).end);
      const better = pending ? await pending.catch((err) => { console.error(err); return null; }) : null;
      if (generation !== this.generation || this.closed) return;
      if (better?.words.length) {
        timedWords = better.words.map((w) => ({ text: w.text, start: w.start + better.offset - t0, end: w.end + better.offset - t0 }));
        text = better.text.trim() || timedWords.map((w) => w.text).join(' ');
      }
    }

    // Whose voice is this? (voiceprint, ~20 ms each) The verdict guides the styling below.
    // Labeling everyone, Scribe often commits two people's turns as one line:
    // each turn (split at pauses, at least TURN_MIN_SEC long) is identified on its own.
    const turns = timedWords ? (this.prosody.multi ? splitTurns(timedWords) : [timedWords]) : [];
    /** @type {(import('./voiceprint-core.js').Verdict | null)[]} */
    const voices = turns.map(() => null);
    if (timedWords && this.t0 != null && this.identify) {
      for (const [i, turn] of turns.entries()) {
        const pending = this.identify(this.t0 + turn[0].start, this.t0 + turn.at(-1).end);
        if (!pending) break;
        voices[i] = await pending.catch((err) => { console.error(err); return null; });
        if (generation !== this.generation) return; // recalibrated meanwhile: a different voice now
      }
    }
    const voice = voices.at(-1) ?? null;

    let words;
    if (timedWords && this.t0 != null) {
      this.origin ??= this.t0;
      const shift = this.t0 - this.origin; // > 0 after a reconnect restarted Scribe's clock
      const styled = turns.flatMap((turn, i) => {
        this.prosody.voice = voices[i];
        return turn.map((w) => ({
          word: w.text.trim(),
          ...this.prosody.styleWord(w.text, this.t0 + w.start, this.t0 + w.end),
          start: w.start + shift, end: w.end + shift,
        }));
      }).filter((w) => w.word);
      this.prosody.voice = null;
      // Words someone else said near the mic (prosody marks them) are dropped.
      // Single-speaker mode drops mostly-background lines. Multiple speakers
      // can change turns inside a commit, so keep each individually matched word.
      const others = styled.filter((w) => w.background).length;
      words = !this.prosody.filterWordsIndividually && others * 2 > styled.length ? [] : styled.filter((w) => !w.background);
      if (words.length < styled.length) text = words.map((w) => w.word).join(' ');
    } else {
      // Filtered multi-speaker lines need timings to tell speakers apart; otherwise plain words.
      words = this.prosody.requireTimed && this.prosody.focus ? [] : splitWords(text).map(plainWord);
      // Labeling everyone: no timings, no voiceprint; it stays with whoever spoke last (not an unlabeled lane).
      if (this.prosody.multi) words = words.map((w) => ({ ...w, speaker: this.lastSpeaker ?? 1 }));
    }
    const report = { heard: rawText, shown: words.map((w) => w.word).join(' '), timed: !!timedWords };
    this.heard.push(report);
    if (this.heard.length > 20) this.heard.shift();
    this.onStyled(voice);
    if (suppress) return; // enrollment phrases teach calibration, never captions or exports
    if (!words.length) { // all someone else: take the line off screen, caption nothing
      this.send({ type: 'line', line: id, final: true, provisional: false, emotion: 'neutral', confidence: 0, words: [] });
      return;
    }

    const speaker = lineSpeaker(words);
    if (speaker) this.lastSpeaker = speaker;
    const base = { type: /** @type {const} */ ('line'), line: id, words, ...(speaker ? { speaker } : {}) };
    this.send({ ...base, final: false, provisional: true, emotion: this.mood() ?? provisional, confidence: 0 });

    /** @type {import('./caption.js').Emotion} */
    let emotion = 'neutral';
    let confidence = 0, info = null;
    const timed = words.filter((w) => typeof w.start === 'number');
    const tone = timed.length && this.t0 != null && this.origin != null
      ? this.prosody.toneOf?.(this.origin + timed[0].start, this.origin + timed.at(-1).end, timed.length, speaker) ?? null
      : null;
    const taught = tone ? this.prosody.toneBookFor?.(speaker)?.match(tone) ?? null : null;
    const span = timed.length && this.origin != null ? { start: this.origin + timed[0].start, end: this.origin + timed.at(-1).end } : null;
    const pending = this.classify(text, words.map((w) => w.level), tone, taught, span);
    if (pending) {
      try {
        info = await pending;
        ({ emotion, confidence } = info);
      } catch (err) { console.error(err); }
    }
    // For the mic report: why this line got its color (tuning emotion on real streams).
    const detail = /** @type {{ energy?: number, top?: string, reason?: string } | null} */ (info);
    report.emotion = { result: emotion, confidence: +confidence.toFixed(2), energy: detail?.energy != null ? +detail.energy.toFixed(2) : undefined, text: detail?.top, why: detail?.reason || undefined,
      tone: tone && Object.fromEntries(Object.entries(tone).map(([k, v]) => [k, Math.round(v * 100) / 100])), taught: taught?.confident ? taught.emotion : undefined };
    if (untimed?.superseded || generation !== this.generation) return;
    const forced = this.mood();
    if (forced) { emotion = forced; confidence = 1; }
    if (untimed) untimed.emotion = emotion;
    this.send({ ...base, final: true, provisional: false, emotion, confidence: +confidence.toFixed(2) });
    const line = { line: id, text, emotion, confidence, words, ...(speaker ? { speaker } : {}) };
    if (words.every((w) => typeof w.start === 'number')) this.lines.push(line);
    this.onFinal(line, info, tone);
  }
}
