// Voiceprints: captions only the voices that were calibrated. A speaker
// embedding (voiceprint.js: WeSpeaker ResNet34, on-device) of the audio
// calibration learned from is each profile's voiceprint; every committed line
// is embedded too and compared by cosine similarity.
//
// No DOM and no model here: `embed` is injected, so the browser (voiceprint.js),
// the eval script and the tests share this logic. Audio and voiceprints live in
// memory only, for this session.
//
// Thresholds: scripts/eval-voiceprint.mjs (macOS voices, clean and as a MacBook
// mic hears a room) had the same speaker at 0.66-0.84 on lines of 1 s or more
// and other voices at most 0.59 (0.47 with room echo); 'strict' sits between.
// A real person on the MacBook mic scored their own lines lower and was
// rejected, so the default is 'relaxed': drop only lines that clearly aren't
// a calibrated voice (strangers in the eval: 0.20 or less). Single words score
// lower for everyone (the speaker's own "No." was 0.41), so short lines need
// more evidence before anything is dropped.

/** Voice filter strictness (control panel): the cosine scores that decide. */
export const STRICTNESS = {
  relaxed: { MATCH: 0.5, OTHER: 0.25, MATCH_SHORT: 0.45, OTHER_SHORT: 0.15 },
  strict: { MATCH: 0.6, OTHER: 0.45, MATCH_SHORT: 0.55, OTHER_SHORT: 0.3 },
};

export const VOICE = {
  ...STRICTNESS.relaxed,
  LEARN_MAX: 8,      // lines judged 'match' that refine a voiceprint (it follows the speaker's mic, room and loudness)
  LONG_SEC: 1.0,
  MIN_SEC: 0.4,      // shorter audio isn't judged
  MAX_SEC: 6,        // only the last 6 s of a long line is embedded
  MARGIN: 0.08,      // with several profiles, the best must beat the next by this to be sure (one profile today)
  MIN_VOICED: 0.35,  // a mostly unvoiced (whispered) line has no voiceprint to compare
  ENROLL_MIN_SEC: 1.2,
  PAD_SEC: 0.05,     // word timestamps are tight; take a little around each
  ABOVE_NOISE_DB: 3, // a line this close to the room noise has no voice to judge
};

/**
 * @typedef {{ verdict: 'match' | 'other' | 'unsure', best: number, score: number,
 *   scores: (number | null)[], seconds: number, reason?: string, isNew?: boolean }} Verdict
 *   best: index of the closest profile (-1 if none); score: its similarity
 */

export function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

/**
 * @param {(number | null)[]} scores  similarity to each profile (null = not enrolled)
 * @param {number} seconds  audio length that was embedded
 * @returns {Verdict | null}  null when nobody is enrolled
 */
export function decide(scores, seconds, strictness = 'relaxed') {
  const t = STRICTNESS[strictness] ?? STRICTNESS.relaxed;
  let best = -1, score = -Infinity, second = -Infinity;
  scores.forEach((s, i) => {
    if (s == null) return;
    if (s > score) { second = score; score = s; best = i; } else if (s > second) second = s;
  });
  if (best < 0) return null;
  const long = seconds >= VOICE.LONG_SEC;
  const match = long ? t.MATCH : t.MATCH_SHORT;
  const other = long ? t.OTHER : t.OTHER_SHORT;
  const verdict = score >= match && score - second >= VOICE.MARGIN ? 'match' : score < other ? 'other' : 'unsure';
  return { verdict, best, score, scores, seconds };
}

/** The last `seconds` of 16 kHz mono audio, addressed by AudioContext time. Memory only. */
export class AudioRing {
  constructor({ rate = 16000, seconds = 60 } = {}) {
    this.rate = rate;
    this.buf = new Float32Array(Math.round(rate * seconds));
    this.total = 0;      // samples ever pushed
    this.endT = null;    // time at the end of the newest sample
  }

  /** @param {Int16Array | Float32Array} samples  @param {number} tEnd  time at their end */
  push(samples, tEnd) {
    const scale = samples instanceof Int16Array ? 1 / 32768 : 1;
    for (let i = 0; i < samples.length; i++) this.buf[(this.total + i) % this.buf.length] = samples[i] * scale;
    this.total += samples.length;
    this.endT = tEnd;
  }

  /** Audio between two times, or null if none of it is still held. Parts already gone are left out. */
  slice(start, end) {
    if (this.endT == null || end <= start) return null;
    const at = (t) => Math.round(this.total - (this.endT - t) * this.rate);
    const a = Math.max(at(start), this.total - this.buf.length, 0);
    const b = Math.min(at(end), this.total);
    if (b <= a) return null;
    const out = new Float32Array(b - a);
    for (let i = a; i < b; i++) out[i - a] = this.buf[i % this.buf.length];
    return out;
  }
}

/** Mean direction of several embeddings (each normalized first). */
function centroid(vecs) {
  const out = new Float64Array(vecs[0].length);
  for (const v of vecs) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) out[i] += v[i] / n;
  }
  return out;
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export class Voiceprints {
  /**
   * @param {object} deps
   * @param {(audio: Float32Array) => Promise<ArrayLike<number>>} deps.embed  speaker embedding of 16 kHz audio
   * @param {AudioRing} deps.ring
   */
  constructor({ embed, ring }) {
    this.embed = embed;
    this.ring = ring;
    this.rate = ring.rate;
    /** @type {WeakMap<object, { key: string, vec: ArrayLike<number> | null, learned: ArrayLike<number>[], pending: Promise<void> | null }>} */
    this.enrolled = new WeakMap();
    /** @type {'relaxed' | 'strict'} */
    this.strictness = 'relaxed';
    /** @type {Verdict | null} */
    this.last = null;
  }

  /** The profiles a session compares against: the main speaker's. */
  profilesOf(prosody) { return [prosody]; }

  /** How many profiles have a voiceprint. */
  count(prosody) { return this.profilesOf(prosody).filter((p) => this.enrolled.get(p)?.vec).length; }

  /**
   * (Re)learn each calibrated profile's voiceprint from the audio of the words
   * calibration learned from (the loudest voice: chatter heard before the
   * person spoke is not in it) and the speaker's words right after it
   * (Prosody.enrollSpans). Call after each styled line; cheap when nothing changed.
   */
  async refresh(prosody) {
    const jobs = [];
    for (const p of this.profilesOf(prosody)) {
      const words = p.calibrated ? p.enrollSpans.filter((w) => w.end > w.start) : [];
      const key = words.map((w) => w.start.toFixed(3)).join(',');
      const cur = this.enrolled.get(p);
      if (cur?.key === key) { if (cur.pending) jobs.push(cur.pending); continue; }
      const entry = { key, vec: key ? cur?.vec ?? null : null, learned: [], pending: null };
      this.enrolled.set(p, entry);
      if (!key) continue;
      const parts = words.map((w) => this.ring.slice(w.start - VOICE.PAD_SEC, w.end + VOICE.PAD_SEC)).filter(Boolean);
      const audio = concat(parts);
      if (audio.length < VOICE.ENROLL_MIN_SEC * this.rate) continue; // too little (or already out of the ring): keep the old one
      entry.pending = this.embed(audio)
        .then((vec) => { if (this.enrolled.get(p) === entry) entry.vec = vec; })
        .catch((err) => console.error('voiceprint enrollment', err))
        .finally(() => { entry.pending = null; });
      jobs.push(entry.pending);
    }
    await Promise.all(jobs);
  }

  /**
   * Whose voice is in [start, end] (AudioContext seconds)? null when there is
   * nothing to compare against (filter off, nobody enrolled yet).
   * @returns {Promise<Verdict | null>}
   */
  async identify(prosody, start, end, _live = false) {
    await this.refresh(prosody);
    if (!prosody.focus) return null;
    const entries = this.profilesOf(prosody).map((p) => this.enrolled.get(p));
    const vecs = entries.map((e) => (e?.vec ? centroid([e.vec, ...e.learned]) : null));
    if (vecs.every((v) => !v)) return null;
    const unsure = (reason, seconds = 0) => ({ verdict: /** @type {const} */ ('unsure'), best: -1, score: 0, scores: vecs.map(() => null), seconds, reason });
    const st = prosody.stats(start, end);
    // Not just "speech" (room + 10 dB): on a laptop mic other people sit below that line.
    if (!st || st.db < prosody.noiseDb + VOICE.ABOVE_NOISE_DB) return unsure('no voice in it');
    if (st.voiced < VOICE.MIN_VOICED) return unsure('whispered: no voice to compare');
    const audio = this.ring.slice(Math.max(start, end - VOICE.MAX_SEC) - VOICE.PAD_SEC, end + VOICE.PAD_SEC);
    const seconds = audio ? audio.length / this.rate : 0;
    if (seconds < VOICE.MIN_SEC) return unsure('too short', seconds);
    const vec = await this.embed(audio);
    const scores = vecs.map((v) => (v ? cosine(v, vec) : null));
    const verdict = decide(scores, seconds, this.strictness);
    // A line surely theirs (long, matched) refines their voiceprint: louder, quieter, a different room.
    if (verdict?.verdict === 'match' && seconds >= VOICE.LONG_SEC) {
      const e = entries[verdict.best];
      e.learned.push(vec);
      if (e.learned.length > VOICE.LEARN_MAX) e.learned.shift();
    }
    this.last = verdict;
    return verdict;
  }
}
