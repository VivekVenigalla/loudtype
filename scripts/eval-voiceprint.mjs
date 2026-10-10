// Voiceprint check, offline (no ElevenLabs, no quota): the real-voices ballroom
// (scripts/scenes.mjs, macOS `say`) runs through Loudtype's measuring path with
// the real voiceprint model (onnxruntime-node). Each scene phrase is one
// committed line, as Scribe would send it. Prints each line's verdict and
// whether it is captioned. Needs `npm run setup` (the model in models/).
// Usage: node scripts/eval-voiceprint.mjs [--mac]
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const imp = (p) => import(new URL(p, ROOT).href);
const { voicesScene } = await imp('scripts/scenes.mjs');
const { Prosody } = await imp('control/prosody.js');
const { frameFeatures } = await imp('control/features.js');
const { AudioRing, Voiceprints, VOICE } = await imp('control/voiceprint-core.js');
const { VOICE_MODEL } = await imp('control/caption.js');
const T = await imp('node_modules/@huggingface/transformers/dist/transformers.node.mjs');

T.env.allowRemoteModels = false;
T.env.localModelPath = fileURLToPath(new URL('models/', ROOT)); // the folder name may contain '?'
const processor = await T.AutoProcessor.from_pretrained(VOICE_MODEL);
const model = await T.AutoModel.from_pretrained(VOICE_MODEL, { dtype: 'fp32' });
const times = [];
async function embed(audio) {
  const t = performance.now();
  const out = await model(await processor(audio));
  times.push(performance.now() - t);
  return out.last_hidden_state.data;
}

const mac = process.argv.includes('--mac');
const scene = await voicesScene({ mac });
const p = new Prosody();
const vp = new Voiceprints({ embed, ring: new AudioRing() });

// Calibration needs 6 words: the calibration phrase is styled as 6 pieces.
const lines = scene.spans.map((s) => ({
  span: s,
  words: s.kind === 'calib'
    ? Array.from({ length: 6 }, (_, i) => [s.start + (i * (s.end - s.start)) / 6, s.start + ((i + 1) * (s.end - s.start)) / 6])
    : [[s.start, s.end]],
}));

const N = Math.round(scene.rate * 0.033);
const ratio = scene.rate / 16000;
let next = 0, j = 0;
const results = [];
for (let i = 0; i + N <= scene.audio.length; i += N) {
  const t = (i + N) / scene.rate;
  const f = frameFeatures(scene.audio.subarray(i, i + N), scene.rate);
  p.push(t, f.db, f.voicing, f.pitch);
  const chunk = [];
  for (; (j + 1) * ratio <= i + N; j++) {
    let s = 0;
    for (let k = 0; k < ratio; k++) s += scene.audio[j * ratio + k];
    chunk.push(s / ratio);
  }
  vp.ring.push(Float32Array.from(chunk), j / 16000);
  while (next < lines.length && lines[next].span.end + 0.1 <= t) {
    const { span, words } = lines[next++];
    const voice = await vp.identify(p, span.start, span.end);
    p.voice = voice;
    const styled = words.map(([a, b]) => p.styleWord(span.text, a, b));
    p.voice = null;
    await vp.refresh(p);
    results.push({ span, voice, captioned: styled.some((w) => !w.background), levels: [...new Set(styled.map((w) => w.level))].join('/') });
  }
}

console.log(`scene: ${mac ? 'MacBook mic' : 'close mic'} · thresholds: match ≥ ${VOICE.MATCH} (short ${VOICE.MATCH_SHORT}), other < ${VOICE.OTHER} (short ${VOICE.OTHER_SHORT})`);
let right = 0;
for (const { span, voice, captioned, levels } of results) {
  const want = span.who === 'main';
  if (captioned === want) right++;
  const v = voice ? `${voice.verdict.padEnd(6)} ${voice.reason ?? voice.score.toFixed(2)}` : 'no voiceprint yet';
  console.log(`${captioned === want ? 'ok ' : 'BAD'} ${`${span.who}/${span.kind}`.padEnd(16)} ${(captioned ? `captioned ${levels}` : 'dropped').padEnd(22)} ${v.padEnd(28)} "${span.text}"`);
}
console.log(`${right}/${results.length} lines right · embedding ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)} ms avg on this machine (onnxruntime-node)`);
