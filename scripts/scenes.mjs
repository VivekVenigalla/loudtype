// Ballroom test scenes: a main speaker on a close mic, plus background chatter,
// room noise, claps and someone talking nearby. Used by test/ballroom*.test.js,
// scripts/eval-ballroom.mjs and the fake-mic browser test.
//
// Each scene: { rate, audio: Float32Array, spans: [{ who, kind, start, end, text }] }
//   who:  'main' | 'nearby' | 'clap'
//   kind: main → 'calib' | 'normal' | 'whisper' | 'shout'; nearby → 'near' | 'far' | 'far-same' (at the main speaker's pitch)
// Levels are dBFS RMS. Main speaker normal = -20 (close mic).
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RATE = 48000;
export const MAIN_DB = -20;
export const LEVEL = {
  whisper: MAIN_DB - 11,
  shout: MAIN_DB + 11,
  near: MAIN_DB - 8,  // someone leaning in: the word filter's job
  far: MAIN_DB - 20,  // someone at the next seat: the gate's job
  babble: MAIN_DB - 26, // each of the background voices
  clap: MAIN_DB + 8,
  room: MAIN_DB - 38,
};

/** Deterministic PRNG so every run builds the same scene. */
export function rng(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));
function setLevel(x, db) { // scale to an RMS level, measured over the loud part
  const loud = x.filter((v) => Math.abs(v) > 1e-4);
  const g = 10 ** (db / 20) / (rms(loud) || 1);
  return x.map((v) => v * g);
}
function mix(audio, x, at, rate = RATE) {
  const o = Math.round(at * rate);
  for (let i = 0; i < x.length && o + i < audio.length; i++) audio[o + i] += x[i];
}

// ---------- synthetic voices ----------
// A voiced "word": harmonics of a slowly wandering pitch, shaped into syllables.
function voiced(sec, f0, rand, { syllables = 2 } = {}) {
  const n = Math.round(sec * RATE), x = new Float32Array(n);
  let phase = 0, drift = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    drift += (rand() - 0.5) * 0.002;
    drift = Math.max(-0.04, Math.min(0.04, drift));
    phase += (2 * Math.PI * f0 * (1 + drift)) / RATE;
    let s = 0;
    for (let k = 1; k <= 12; k++) s += Math.sin(k * phase) / k;
    const env = Math.sin(Math.PI * ((t * syllables / sec) % 1)) ** 0.6; // syllable bumps
    x[i] = s * env * Math.min(1, t / 0.02, (sec - t) / 0.02);
  }
  return x;
}
// An unvoiced "word": breathy noise (no pitch) in the speech band (~0.3-4 kHz),
// shaped like the voiced ones.
function breathy(sec, rand) {
  const n = Math.round(sec * RATE), x = new Float32Array(n);
  let low = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    low += 0.4 * (rand() * 2 - 1 - low); // one-pole low-pass, ~4 kHz
    x[i] = (low - 0.9 * prev) * Math.sin(Math.PI * ((t * 2 / sec) % 1)) ** 0.6; // minus the lows
    prev = low;
  }
  return x;
}
function clap(rand) {
  const n = Math.round(0.03 * RATE), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (rand() * 2 - 1) * Math.exp(-i / (0.006 * RATE));
  return x;
}

/**
 * Fully synthetic ballroom: no external tools, deterministic.
 * `babbleDb`: each chatter voice's level (dBFS); the default is a loud room.
 */
export function synthScene({ babbleDb = LEVEL.babble } = {}) {
  const rand = rng(7);
  const spans = [];
  let t = 1.0;
  const word = (who, kind, sec, gap = 0.25) => { const s = { who, kind, start: t, end: t + sec, text: `${who}-${kind}` }; spans.push(s); t += sec + gap; return s; };
  const main = [];
  for (let i = 0; i < 6; i++) main.push([word('main', 'calib', 0.35), 180]);
  for (let i = 0; i < 2; i++) main.push([word('main', 'normal', 0.35), 185]);
  t += 0.6;
  const far = [word('nearby', 'far', 0.4, 0.3), word('nearby', 'far', 0.4, 0.3), word('nearby', 'far-same', 0.4, 0.8)];
  for (let i = 0; i < 2; i++) main.push([word('main', 'whisper', 0.4), 0]);
  t += 0.6;
  const near = [word('nearby', 'near', 0.4, 0.3), word('nearby', 'near', 0.4, 0.8)];
  for (let i = 0; i < 2; i++) main.push([word('main', 'shout', 0.4), 255]); // shouting raises pitch ~6 semitones
  t += 0.6;
  const claps = [word('clap', 'clap', 0.03, 0.8), word('clap', 'clap', 0.03, 0.8)];
  main.push([word('main', 'normal', 0.35), 178]);
  const sec = t + 1.0;

  const audio = new Float32Array(Math.round(sec * RATE));
  for (const [s, f0] of main) {
    const x = s.kind === 'whisper' ? breathy(s.end - s.start, rand) : voiced(s.end - s.start, f0, rand);
    mix(audio, setLevel(x, LEVEL[s.kind] ?? MAIN_DB), s.start);
  }
  for (const s of [...far, ...near]) {
    const f0 = s.kind === 'far-same' ? 175 : 110; // 'far-same': a neighbour at the main speaker's pitch
    mix(audio, setLevel(voiced(s.end - s.start, f0, rand), LEVEL[s.kind.replace('-same', '')]), s.start);
  }
  for (const s of claps) mix(audio, setLevel(clap(rand), LEVEL.clap), s.start);
  // Chatter: six voices at different pitches, talking on and off the whole time.
  for (const f0 of [95, 120, 140, 205, 230, 250]) {
    for (let at = rand() * 0.5; at < sec - 0.6; at += 0.5 + rand() * 0.6) {
      const len = 0.25 + rand() * 0.35;
      mix(audio, setLevel(voiced(len, f0 * (0.9 + rand() * 0.2), rand, { syllables: 1 }), babbleDb), at);
    }
  }
  const room = 10 ** (LEVEL.room / 20) * Math.sqrt(3);
  for (let i = 0; i < audio.length; i++) audio[i] += (rand() * 2 - 1) * room;
  return { rate: RATE, audio, spans };
}

// ---------- real voices (macOS `say`) ----------
export function hasSay() {
  try { execFileSync('say', ['-v', '?'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/**
 * Real voices: Samantha is the main speaker, Daniel talks nearby (lower
 * pitch), four other voices are the ballroom chatter.
 */
export async function voicesScene() {
  const dir = mkdtempSync(join(tmpdir(), 'lt-scene-'));
  let files = 0;
  const say = async (voice, text) => {
    const f = join(dir, `${files++}.wav`);
    await promisify(execFile)('say', ['-v', voice, '-o', f, `--data-format=LEI16@${RATE}`, text]);
    const b = readFileSync(f), pcm = b.subarray(b.indexOf('data') + 8);
    const x = new Float32Array(pcm.length / 2);
    for (let i = 0; i < x.length; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
    let a = 0, z = x.length; // trim the silence say adds
    while (a < z && Math.abs(x[a]) < 1e-3) a++;
    while (z > a && Math.abs(x[z - 1]) < 1e-3) z--;
    return x.subarray(a, z);
  };
  try {
    const rand = rng(11);
    const lines = [
      ['main', 'calib', 'Samantha', 'Hi, I am one of the judges at Hacklanta today.'],
      ['main', 'normal', 'Samantha', 'Okay chat, welcome back to the stream.'],
      ['nearby', 'far', 'Daniel', 'Did you see the keynote this morning?'],
      ['nearby', 'far-same', 'Tessa', 'I love the lights in this room.'], // the main speaker's pitch range
      ['main', 'whisper', 'Whisper', 'This is the best day ever.'],
      ['nearby', 'near', 'Daniel', 'Can somebody pass me the water please?'],
      ['main', 'shout', 'Samantha', 'We actually won the game!'],
      ['main', 'normal', 'Samantha', 'Let me check the map real quick.'],
    ];
    const chatter = ['How was the drive in today?', 'The food here is great.', 'We should get a table near the stage.', 'I think it starts at noon.', 'Have you met the sponsors yet?'];
    const chatterVoices = ['Karen', 'Fred', 'Moira', 'Rishi'];
    // One say call per line and one long ramble per chatter voice, all in parallel.
    const [said, rambles] = await Promise.all([
      Promise.all(lines.map(([, , voice, text]) => say(voice, text))),
      Promise.all(chatterVoices.map((voice, v) => say(voice, chatter.map((c, i) => chatter[(i + v) % chatter.length]).join(' [[slnc 400]] ').repeat(2)))),
    ]);
    const spans = [];
    const clips = [];
    let t = 1.0;
    for (const [i, [who, kind, , text]] of lines.entries()) {
      const x = said[i];
      spans.push({ who, kind, start: t, end: t + x.length / RATE, text });
      clips.push([x, LEVEL[kind.replace('-same', '')] ?? MAIN_DB, t]);
      t += x.length / RATE + 1.0;
    }
    const sec = t + 0.5;
    const audio = new Float32Array(Math.round(sec * RATE));
    for (const [x, db, at] of clips) mix(audio, setLevel(x, db), at);
    for (const x of rambles) mix(audio, setLevel(x.subarray(0, Math.min(x.length, audio.length)), LEVEL.babble), rand() * 0.8);
    const room = 10 ** (LEVEL.room / 20) * Math.sqrt(3);
    for (let i = 0; i < audio.length; i++) audio[i] += (rand() * 2 - 1) * room;
    return { rate: RATE, audio, spans };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- running a scene through Loudtype's measuring path ----------
// Scribe times each word; a scene times whole phrases. Calibration needs 6
// words, so a long 'calib' span is styled as 6 word-sized pieces.
function wordsOf(spans) {
  return spans.flatMap((s) => {
    if (s.kind !== 'calib' || s.end - s.start < 1) return [s];
    const step = (s.end - s.start) / 6;
    return Array.from({ length: 6 }, (_, i) => ({ ...s, start: s.start + i * step, end: s.start + (i + 1) * step, text: `${s.text} #${i + 1}`, parent: s }));
  }).sort((a, b) => a.end - b.end);
}

/** Frames → Prosody, like the worklet; then styleWord on each span in order. */
export function measure(scene, { Prosody, frameFeatures }, { focus = true } = {}) {
  const p = new Prosody();
  p.focus = focus;
  const N = Math.round(scene.rate * 0.033);
  const order = wordsOf(scene.spans);
  const styled = new Map();
  let next = 0;
  for (let i = 0; i + N <= scene.audio.length; i += N) {
    const t = (i + N) / scene.rate;
    const f = frameFeatures(scene.audio.subarray(i, i + N), scene.rate);
    p.push(t, f.db, f.voicing, f.pitch);
    // A word is styled once its audio is in (Scribe commits after the word ends).
    while (next < order.length && order[next].end + 0.1 <= t) {
      const s = order[next++];
      styled.set(s.parent ?? s, p.styleWord(s.text, s.start, s.end));
    }
  }
  return { prosody: p, styled };
}

/**
 * The speech-to-text path: 16 kHz box-filter downsample (as the worklet does),
 * through the gate, with the threshold updated from prosody every 100 ms.
 * Returns the gated 16 kHz audio and its delay.
 */
export function gateScene(scene, { Prosody, frameFeatures, Gate }, { focus = true } = {}) {
  const p = new Prosody();
  p.focus = focus;
  const gate = new Gate({ rate: 16000 });
  const ratio = scene.rate / 16000;
  const N = Math.round(scene.rate * 0.033);
  const out = new Float32Array(Math.floor(scene.audio.length / ratio));
  const plain = new Float32Array(out.length); // same path, gate open: what speech-to-text would get without it
  const order = wordsOf(scene.spans);
  let next = 0, j = 0;
  for (let i = 0; i + N <= scene.audio.length; i += N) {
    const t = (i + N) / scene.rate;
    const f = frameFeatures(scene.audio.subarray(i, i + N), scene.rate);
    p.push(t, f.db, f.voicing, f.pitch);
    while (next < order.length && order[next].end + 0.1 <= t) { const s = order[next++]; p.styleWord(s.text, s.start, s.end); }
    if (Math.floor(t * 10) !== Math.floor((t - 0.033) * 10)) gate.setThreshold(p.gateDb()); // the app updates it ~every frame
    for (; j < out.length && (j + 1) * ratio <= i + N; j++) {
      let s = 0;
      for (let k = 0; k < ratio; k++) s += scene.audio[j * ratio + k];
      plain[j] = s / ratio;
      out[j] = gate.push(plain[j]);
    }
  }
  return { audio: out, plain, delaySec: gate.delaySec, prosody: p };
}

/** Share of a span's energy speech-to-text still hears (gated vs. the same path ungated). */
export function passed(gated, span) {
  const e = (x, a, b) => { let s = 0; for (let i = Math.round(a * 16000); i < Math.min(x.length, Math.round(b * 16000)); i++) s += x[i] * x[i]; return s; };
  const before = e(gated.plain, span.start, span.end);
  const after = e(gated.audio, span.start + gated.delaySec, span.end + gated.delaySec);
  return before ? after / before : 0;
}

/** 16-bit mono WAV, for the fake-mic browser test. */
export function writeWav(path, audio, rate) {
  const data = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, audio[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}
