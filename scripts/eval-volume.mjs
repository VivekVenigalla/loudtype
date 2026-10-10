// Volume-detection test with known answers.
// Builds a clip (macOS `say`) where every word's intended level is known,
// gets real word timestamps from ElevenLabs Scribe, then scores the
// loudness → level logic. Usage: node scripts/eval-volume.mjs [old-prosody.js]
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const { CONFIG } = await import(new URL('config.js', ROOT));
const { frameFeatures } = await import(new URL('control/features.js', ROOT));
const { Prosody, LEVEL_ORDER } = await import(new URL('control/prosody.js', ROOT));
const OldProsody = process.argv[2] ? (await import(pathToFileURL(process.argv[2]).href)).Prosody : null;

const SR = 48000;
const NORMAL_RMS_DB = -30;
const dir = mkdtempSync(join(tmpdir(), 'lt-'));

function speak(text, voice) {
  const f = join(dir, `${Math.random().toString(36).slice(2)}.wav`);
  execFileSync('say', ['-v', voice, '-o', f, `--data-format=LEI16@${SR}`, text]);
  const b = readFileSync(f);
  const pcm = b.subarray(b.indexOf('data') + 8);
  const out = new Float32Array(pcm.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  // Normalize speech to a common level, then apply the intended gain.
  let s = 0, n = 0;
  for (const v of out) if (Math.abs(v) > 0.003) { s += v * v; n++; }
  const rmsDb = 10 * Math.log10(s / Math.max(1, n));
  return { out, norm: NORMAL_RMS_DB - rmsDb };
}

// [text, voice, gain dB vs normal, expected level]
const SEGMENTS = [
  ['Okay chat, welcome back to the stream.', 'Samantha', 0, 'normal'],
  ['Today we are trying a brand new game.', 'Samantha', 0, 'normal'],
  ['Shh, this is the best day ever.', 'Whisper', 0, 'whisper'],      // whisper as loud as normal speech
  ['Please keep your voice down.', 'Whisper', -8, 'whisper'],
  ['I really miss my old dog.', 'Samantha', -7, 'soft'],
  ['We actually won the game!', 'Samantha', 13, 'shout'],
  ['That was so sick.', 'Samantha', 7, 'loud'],
  ['I told you', 'Samantha', 0, 'normal'],
  ['no!', 'Samantha', 13, 'shout'],
  ['again.', 'Samantha', 0, 'normal'],
  ['Let me check the map real quick.', 'Samantha', 0, 'normal'],
  ['This is so quiet now.', 'Samantha', -13, 'whisper'],
];

const parts = [], spans = [];
let t = 0;
const gap = (sec) => { parts.push(new Float32Array(Math.round(sec * SR))); t += sec; };
gap(0.5);
SEGMENTS.forEach(([text, voice, gain, want], i) => {
  const { out, norm } = speak(text, voice);
  const g = Math.pow(10, (norm + gain) / 20);
  for (let k = 0; k < out.length; k++) out[k] = Math.max(-1, Math.min(1, out[k] * g));
  parts.push(out);
  spans.push({ start: t, end: t + out.length / SR, want, text });
  t += out.length / SR;
  const inSentence = i === 7 || i === 8; // "I told you | no! | again."
  gap(inSentence ? 0.05 : 1.0);
});
const total = parts.reduce((a, p) => a + p.length, 0);
const audio = new Float32Array(total);
let o = 0;
for (const p of parts) { audio.set(p, o); o += p.length; }
for (let i = 0; i < audio.length; i++) audio[i] += (Math.random() - 0.5) * 0.004; // room noise ≈ -55 dBFS

// 16 kHz PCM for Scribe (box-filter decimation, same as the worklet).
const pcm16 = Buffer.alloc(Math.floor(audio.length / 3) * 2);
for (let i = 0; i < pcm16.length / 2; i++) {
  const v = (audio[i * 3] + audio[i * 3 + 1] + audio[i * 3 + 2]) / 3;
  pcm16.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2);
}

// --- Scribe word timestamps ---
const tok = await (await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
  method: 'POST', headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY } })).json();
const q = new URLSearchParams({ model_id: 'scribe_v2_realtime', token: tok.token, audio_format: 'pcm_16000',
  commit_strategy: 'vad', include_timestamps: 'true', vad_silence_threshold_secs: '0.6' });
const words = await new Promise((resolve) => {
  const ws = new WebSocket('wss://api.elevenlabs.io/v1/speech-to-text/realtime?' + q);
  const got = [];
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.message_type === 'committed_transcript_with_timestamps') got.push(...(d.words || []).filter((w) => w.type === 'word'));
  };
  ws.onclose = () => resolve(got);
  ws.onopen = async () => {
    const CH = 3200;
    for (let i = 0; i < pcm16.length; i += CH) {
      ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm16.subarray(i, i + CH).toString('base64'), commit: false, sample_rate: 16000 }));
      await new Promise((r) => setTimeout(r, 40)); // 2.5× real time
    }
    for (let i = 0; i < 25; i++) {
      ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.alloc(CH).toString('base64'), commit: false, sample_rate: 16000 }));
      await new Promise((r) => setTimeout(r, 40));
    }
    setTimeout(() => ws.close(), 2500);
  };
});

// --- Score ---
const FRAME = Math.round(SR * 0.033);
function run(P, withVoicing) {
  const p = new P();
  for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
    const f = frameFeatures(audio.subarray(i, i + FRAME), SR);
    withVoicing ? p.push((i + FRAME) / SR, f.db, f.voicing) : p.push((i + FRAME) / SR, f.db);
  }
  let exact = 0, near = 0, n = 0;
  const rows = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    const seg = spans.find((s) => mid >= s.start - 0.1 && mid <= s.end + 0.1);
    const st = p.styleWord(w.text, w.start, w.end);
    if (!seg || !p.calibrated) { rows.push(`  (calibrating) ${w.text} → ${st.level}`); continue; }
    n++;
    const dist = Math.abs(LEVEL_ORDER.indexOf(st.level) - LEVEL_ORDER.indexOf(seg.want));
    exact += dist === 0; near += dist <= 1;
    rows.push(`${dist === 0 ? '✓' : dist === 1 ? '~' : '✗'} ${w.text.padEnd(10)} want ${seg.want.padEnd(8)} got ${st.level}`);
  }
  return { exact, near, n, rows };
}

console.log(`Scribe returned ${words.length} words\n`);
const fresh = run(Prosody, true);
if (OldProsody) {
  const old = run(OldProsody, false);
  console.log(`OLD (z-score):        exact ${old.exact}/${old.n}  within one level ${old.near}/${old.n}`);
}
console.log(`NEW (dB + voicing):   exact ${fresh.exact}/${fresh.n}  within one level ${fresh.near}/${fresh.n}\n`);
console.log(fresh.rows.join('\n'));
