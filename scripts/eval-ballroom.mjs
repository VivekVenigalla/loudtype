// Ballroom test with real speech-to-text: the real-voices scene from
// scenes.mjs (main speaker + people nearby + four chatter voices + room noise)
// is sent to ElevenLabs Scribe twice: once as-is with no filtering, once
// through Loudtype's background gate. Each transcribed word is then styled
// (with or without the main-speaker filter) and attributed to whoever was
// speaking at its timestamp. Needs the API key; uses ~1 min of Scribe audio.
// Usage: node scripts/eval-ballroom.mjs
import { voicesScene, gateScene, writeWav } from './scenes.mjs';

const ROOT = new URL('..', import.meta.url);
const { CONFIG } = await import(new URL('config.js', ROOT));
const { Prosody } = await import(new URL('control/prosody.js', ROOT));
const { frameFeatures } = await import(new URL('control/features.js', ROOT));
const { Gate } = await import(new URL('control/gate.js', ROOT));

const scene = await voicesScene();
const deps = { Prosody, frameFeatures, Gate };
const gated = gateScene(scene, deps);
if (process.argv[2]) { writeWav(process.argv[2], scene.audio, scene.rate); console.log(`wrote ${process.argv[2]}`); }

async function transcribe(audio16k) {
  const pcm = Buffer.alloc(audio16k.length * 2);
  for (let i = 0; i < audio16k.length; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, audio16k[i])) * 32767), i * 2);
  const tok = await (await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
    method: 'POST', headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY } })).json();
  const q = new URLSearchParams({ model_id: CONFIG.STT_MODEL_ID || 'scribe_v2_realtime', token: tok.token, audio_format: 'pcm_16000',
    commit_strategy: 'vad', include_timestamps: 'true', vad_silence_threshold_secs: String(CONFIG.VAD_SILENCE_SECS || 0.6) });
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://api.elevenlabs.io/v1/speech-to-text/realtime?' + q);
    const words = [];
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.message_type === 'committed_transcript_with_timestamps') words.push(...(d.words || []).filter((w) => w.type === 'word'));
    };
    ws.onclose = () => resolve(words);
    ws.onopen = async () => {
      const CH = 3200; // 100 ms
      for (let i = 0; i < pcm.length; i += CH) {
        ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm.subarray(i, i + CH).toString('base64'), commit: false, sample_rate: 16000 }));
        await new Promise((r) => setTimeout(r, 40)); // 2.5x real time
      }
      for (let i = 0; i < 25; i++) {
        ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.alloc(CH).toString('base64'), commit: false, sample_rate: 16000 }));
        await new Promise((r) => setTimeout(r, 40));
      }
      setTimeout(() => ws.close(), 2500);
    };
  });
}

// Style each word as the app would (frames from the full-rate audio), then
// attribute it to the scene span its middle falls in (anything else = chatter).
function score(words, shift, focus) {
  const p = new Prosody();
  p.focus = focus;
  const N = Math.round(scene.rate * 0.033);
  const out = [];
  let w = 0;
  for (let i = 0; i + N <= scene.audio.length; i += N) {
    const t = (i + N) / scene.rate;
    const f = frameFeatures(scene.audio.subarray(i, i + N), scene.rate);
    p.push(t, f.db, f.voicing, f.pitch);
    while (w < words.length && words[w].end - shift + 0.1 <= t) {
      const x = words[w++], start = x.start - shift, end = x.end - shift, mid = (start + end) / 2;
      const span = scene.spans.find((s) => mid >= s.start - 0.15 && mid <= s.end + 0.15);
      out.push({ text: x.text.trim(), who: span ? `${span.who}${span.who === 'main' ? '' : '/' + span.kind}` : 'chatter', span, ...p.styleWord(x.text, start, end) });
    }
  }
  return out;
}

const runs = [
  ['No filtering (gate off, filter off)', scene, 0, false],
  ['Loudtype (gate + main-speaker filter)', gated, gated.delaySec, true],
];
const counts = {};
for (const [name, src, shift, focus] of runs) {
  const audio16k = src === scene ? gated.plain : gated.audio;
  const words = await transcribe(audio16k);
  const styled = score(words, shift, focus);
  const shown = styled.filter((x) => !x.background);
  const tally = (list) => list.reduce((m, x) => ((m[x.who] = (m[x.who] || 0) + 1), m), {});
  counts[name] = { transcribed: tally(styled), captioned: tally(shown) };
  console.log(`\n== ${name}`);
  console.log(`   transcribed: ${JSON.stringify(tally(styled))}`);
  console.log(`   captioned:   ${JSON.stringify(tally(shown))}`);
  for (const s of scene.spans) {
    const mine = shown.filter((x) => x.span === s);
    const levels = [...new Set(mine.map((x) => x.level))].join('/') || '-';
    console.log(`   ${`${s.who}/${s.kind}`.padEnd(16)} ${String(mine.length).padStart(2)} words captioned, levels ${levels.padEnd(14)} "${s.text}"`);
  }
  const extra = shown.filter((x) => x.who === 'chatter');
  if (extra.length) console.log(`   chatter captioned: ${extra.map((x) => x.text).join(' ')}`);
}
