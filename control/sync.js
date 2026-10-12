// Sync mode: captions land when the DELAYED stream says the words.
//
// Streams usually reach viewers 5-10 s after the streamer speaks (OBS stream
// delay, platform latency). With a delay set, each finished caption line is
// held and its words are sent to the overlay one by one at
// (when the word was spoken + delay), so they appear with the voice viewers
// hear. Live guesses (partials) are never shown in sync mode: by the time a
// word is due, its line has the accurate second-pass words, the loudness
// styling and the final emotion, so nothing changes color or flickers on screen.
// A line that arrives after its words were due is shown at once (catch up).
//
// No DOM: app.js wires it between the transcript and the relay; tests drive it
// with a fake clock.

const KEEP = 30; // lines of "ready after" measurements kept

export class CaptionSync {
  /**
   * @param {object} deps
   * @param {(msg: import('./caption.js').CaptionEvent) => void} deps.out  sends to the overlay (relay)
   * @param {() => number} deps.now  AudioContext seconds (the clock word times are on)
   * @param {() => number | null} deps.origin  AudioContext time of the session clock's 0 (transcript.origin)
   * @param {number} [deps.delay]  seconds; 0 = live (every event passes straight through)
   * @param {() => number} [deps.lag]  for untimed lines: how long ago their last word was probably said
   * @param {(fn: () => void, ms: number) => any} [deps.setTimer]
   * @param {(id: any) => void} [deps.clearTimer]
   */
  // Timers wrapped, not passed bare: called as this.setTimer(...), the browser's setTimeout
  // throws "Illegal invocation" (it must be called on window). Node doesn't mind, so tests can't catch it.
  constructor({ out, now, origin, delay = 0, lag = () => 0.8, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id) }) {
    this.out = out;
    this.now = now;
    this.origin = origin;
    this.delay = delay;
    this.lag = lag;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** @type {Map<number, any[]>} line id → pending timers */
    this.timers = new Map();
    /** @type {number[]} seconds from a line's FIRST spoken word to its finished caption (what the delay must cover) */
    this.ready = [];
  }

  get on() { return this.delay > 0; }

  /** @param {import('./caption.js').CaptionEvent} msg */
  send(msg) {
    if (msg.type === 'clear') this.clear();
    if (msg.type !== 'line') return this.out(msg);
    const origin = this.origin();
    const first = msg.words[0];
    // How long after its first word this line was finished (the rest of the line, the commit pause,
    // the second-pass transcript, emotion): the delay that shows every word of it on time.
    if (msg.final && typeof first?.start === 'number' && origin != null) {
      this.ready.push(this.now() - (origin + first.start));
      if (this.ready.length > KEEP) this.ready.shift();
    }
    if (!this.on) return this.out(msg);
    if (!msg.final) return; // live guesses: never shown in sync mode
    this.cancel(msg.line);
    if (!msg.words.length) return this.out(msg); // the line was dropped: take it off screen now

    const now = this.now();
    const untimedAt = now - this.lag() + this.delay;
    const due = msg.words.map((w) => (typeof w.start === 'number' && origin != null ? origin + w.start + this.delay : untimedAt));
    for (let i = 1; i < due.length; i++) due[i] = Math.max(due[i], due[i - 1]); // never out of order
    // One send per moment a word becomes due, carrying every word due so far.
    const steps = [];
    due.forEach((t, i) => {
      if (steps.length && (t <= now || t === steps.at(-1).t)) steps.at(-1).n = i + 1;
      else steps.push({ t: Math.max(t, now), n: i + 1 });
    });
    const timers = [];
    for (const { t, n } of steps) {
      const show = () => this.out({ ...msg, words: msg.words.slice(0, n) });
      if (t <= now) show();
      else timers.push(this.setTimer(show, (t - now) * 1000));
    }
    if (timers.length) this.timers.set(msg.line, timers);
  }

  cancel(line) {
    for (const id of this.timers.get(line) ?? []) this.clearTimer(id);
    this.timers.delete(line);
  }

  /** Drop everything still waiting (Stop, New judge, clear). */
  clear() { for (const line of [...this.timers.keys()]) this.cancel(line); }

  /**
   * How long after a line's first word it is finished: the typical and the slow
   * case (90th percentile), and a delay that shows (nearly) every word on time.
   * @returns {{ typical: number, slow: number, suggest: number } | null}
   */
  readiness() {
    if (this.ready.length < 3) return null;
    const s = [...this.ready].sort((a, b) => a - b);
    const typical = s[Math.floor(s.length / 2)], slow = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
    return { typical, slow, suggest: Math.ceil((slow + 0.5) * 2) / 2 };
  }
}
