// Emotion on SPOKEN lines (eval-data/emotion/, made by make-emotion-set.mjs
// with ElevenLabs v3 acting out each emotion). Offline, no quota.
// Compares the current emotion logic (text + loudness levels) with versions
// that also hear the voice: pitch, pitch range, loudness and pace
// (control/tone.js) and an optional on-device speech-emotion model.
// Tuning uses voice A (even clips); voice B (odd clips) is held out.
// Usage: node scripts/eval-emotion-voice.mjs [--dump]
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const imp = (p) => import(new URL(p, ROOT).href);
const { Prosody } = await imp('control/prosody.js');
const { frameFeatures } = await imp('control/features.js');
const { decide, voiceEnergy } = await imp('control/emotion-core.js');
const { EMOTION_MODEL } = await imp('control/caption.js');
const tone = await imp('control/tone.js').catch(() => null);
const T = await imp('node_modules/@huggingface/transformers/dist/transformers.node.mjs');
T.env.allowRemoteModels = false;
T.env.localModelPath = fileURLToPath(new URL('models/', ROOT));

const DIR = fileURLToPath(new URL('eval-data/emotion/', ROOT));
const manifest = JSON.parse(readFileSync(DIR + 'manifest.json', 'utf8'));
const text = await T.pipeline('text-classification', EMOTION_MODEL, { dtype: 'q8' });
const SER_MODEL = 'onnx-community/wav2vec2-base-superb-er-ONNX';
// Optional, only if downloaded into models/ (tried 2026-10-10: 9/36 alone, no gain; not part of setup).
const ser = existsSync(fileURLToPath(new URL(`models/${SER_MODEL}/config.json`, ROOT)))
  ? await T.pipeline('audio-classification', SER_MODEL, { dtype: 'q4' })
  : null;

const RATE = 16000, FRAME = Math.round(RATE * 0.033);
const load = (f) => { const b = readFileSync(DIR + f); const x = new Float32Array(b.length / 2); for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(i * 2) / 32768; return x; };

// One Prosody per voice, calibrated on that voice's plain neutral clips (as calibration
// would learn a streamer's normal), then every clip measured against it.
function measure(p, audio, t0) {
  const frames = [];
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    const f = frameFeatures(audio.subarray(i, i + FRAME), RATE);
    const t = t0 + (i + FRAME) / RATE;
    p.push(t, f.db, f.voicing, f.pitch);
    frames.push({ t, ...f });
  }
  return { start: t0, end: t0 + audio.length / RATE, frames };
}
const voices = [...new Set(manifest.map((m) => m.voice))];
const prosodies = new Map();
let clock = 0;
for (const v of voices) {
  const p = new Prosody();
  p.focus = false;
  for (const m of manifest.filter((x) => x.voice === v && x.group === 'neutral')) {
    const audio = load(m.file);
    const { start, end } = measure(p, audio, clock);
    clock = end + 0.5;
    const words = m.text.split(/\s+/);
    words.forEach((w, i) => p.styleWord(w, start + ((end - start) * i) / words.length, start + ((end - start) * (i + 1)) / words.length));
  }
  prosodies.set(v, p);
}

const rows = [];
for (const [i, m] of manifest.entries()) {
  const p = prosodies.get(m.voice);
  const audio = load(m.file);
  const { start, end } = measure(p, audio, clock);
  clock = end + 0.5;
  // Word windows split evenly (the app has Scribe's word timings).
  const words = m.text.split(/\s+/);
  const spans = words.map((w, k) => [start + ((end - start) * k) / words.length, start + ((end - start) * (k + 1)) / words.length]);
  const levels = spans.map(([a, b]) => p.levelFor(p.stats(a, b)));
  const scores = Object.fromEntries((await text(m.text, { top_k: null })).map((x) => [x.label, x.score]));
  const voiceScores = ser ? Object.fromEntries((await ser(audio, { top_k: null })).map((x) => [x.label, x.score])) : null;
  const features = tone ? tone.toneFeatures(p, start, end, words.length) : null;
  rows.push({ i, ...m, held: i % 2 === 1, levels, scores, voiceScores, features });
}

const systems = {
  'current (text + loudness levels)': (r) => decide(r.scores, r.text, voiceEnergy(r.levels), 0.7).emotion,
};
if (ser) systems['voice model alone'] = (r) => ({ neu: 'neutral', hap: 'happy', ang: 'angry', sad: 'sad' })[Object.entries(r.voiceScores).sort((a, b) => b[1] - a[1])[0][0]];
if (tone) {
  systems['new: text + voice tone'] = (r) => tone.decideEmotion(r.scores, r.text, r.features, null, 0.7).emotion;
  if (ser) systems['new: text + voice tone + voice model'] = (r) => tone.decideEmotion(r.scores, r.text, r.features, r.voiceScores, 0.7).emotion;
}

// "Teach it your tones": the speaker taught each mood with the same neutral sentence
// (the 'tone' lines, as the prompt cards do), plus their neutral voice. Each line is
// judged by a book built from that voice's OTHER lines (leave-one-out).
if (tone?.ToneBook) {
  systems['teach your tones (same voice, leave-one-out)'] = (r) => {
    const book = new tone.ToneBook();
    for (const o of rows) {
      if (o === r || o.voice !== r.voice) continue;
      if (o.group === 'neutral') book.teach('neutral', o.features);
      if (o.group === 'tone' && o.emotion !== 'calm') book.teach(o.emotion, o.features); // the cards teach happy, angry, sad
    }
    const taught = book.match(r.features);
    return taught?.confident ? taught.emotion : tone.decideEmotion(r.scores, r.text, r.features, null, 0.7).emotion;
  };
}

if (process.argv.includes('--dump')) {
  for (const r of rows) {
    const f = r.features ? Object.entries(r.features).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`).join(' ') : '';
    const vs = r.voiceScores ? Object.entries(r.voiceScores).map(([k, v]) => `${k}${v.toFixed(2)}`).join(' ') : '';
    console.log(`${r.held ? 'B' : 'A'} ${r.group.padEnd(7)} ${r.emotion.padEnd(7)} ${f} | ${vs} | ${r.levels.join(',')} "${r.text}"`);
  }
}
for (const [name, fn] of Object.entries(systems)) {
  const tally = (list) => `${list.filter((r) => fn(r) === r.emotion).length}/${list.length}`;
  const by = (held) => ['both', 'tone', 'neutral'].map((g) => `${g} ${tally(rows.filter((r) => r.held === held && r.group === g))}`).join(', ');
  console.log(`${name.padEnd(42)} tuning (voice A): ${tally(rows.filter((r) => !r.held))} [${by(false)}] · held out (voice B): ${tally(rows.filter((r) => r.held))} [${by(true)}]`);
}
const misses = rows.filter((r) => r.held).map((r) => [r, Object.fromEntries(Object.entries(systems).map(([n, fn]) => [n, fn(r)]))]);
console.log('\nHeld-out lines (want → per system):');
for (const [r, got] of misses) console.log(`  ${r.group.padEnd(7)} ${r.emotion.padEnd(7)} → ${Object.values(got).map((g) => (g === r.emotion ? g.toUpperCase() : g).padEnd(8)).join(' ')} "${r.text}"`);
