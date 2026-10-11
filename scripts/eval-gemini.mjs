// Gemini emotion judge on the acted ElevenLabs set (eval-data/emotion/): accuracy and latency.
// Uses the Gemini API (GEMINI_API_KEY in config.js); one request per clip, sequential.
// Usage: node scripts/eval-gemini.mjs [model] [thinkingLevel|none] [limit]
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const { CONFIG } = await import(pathToFileURL(fileURLToPath(new URL('config.js', ROOT))).href);
const { geminiEmotion, pcm16ToWav } = await import(new URL('gemini-emotion.js', ROOT).href);
const [model = 'gemini-3.8-flash', thinking = 'minimal', limit = '99'] = process.argv.slice(2);
const DIR = fileURLToPath(new URL('eval-data/emotion/', ROOT));
const manifest = JSON.parse(readFileSync(DIR + 'manifest.json', 'utf8')).slice(0, Number(limit));

const rows = [];
for (const m of manifest) {
  const wav = pcm16ToWav(readFileSync(DIR + m.file));
  try {
    let r;
    for (let tries = 0; ; tries++) {
      try {
        r = await geminiEmotion({ key: CONFIG.GEMINI_API_KEY, model, wav, text: m.text, thinking: thinking === 'none' ? null : thinking, timeoutMs: 15000 });
        break;
      } catch (err) {
        // Free tier: a few requests per minute. Wait as told and retry (latency counts only the answered call).
        const wait = err.message.match(/retry in ([\d.]+)s/)?.[1];
        if (!/Gemini 429/.test(err.message) || tries >= 5) throw err;
        const limit = err.message.match(/limit: (\d+)/)?.[1];
        console.log(`     rate limited (free tier, ${limit ?? '?'} per minute); waiting ${Math.ceil(Number(wait ?? 20))} s`);
        await new Promise((ok) => setTimeout(ok, (Number(wait ?? 20) + 1) * 1000));
      }
    }
    rows.push({ ...m, got: r.emotion, ms: r.ms });
    console.log(`${r.emotion === m.emotion ? 'ok  ' : 'MISS'} ${m.group.padEnd(7)} ${m.emotion.padEnd(7)} → ${r.emotion.padEnd(9)} ${String(r.confidence).padEnd(5)} ${r.ms} ms "${m.text}"`);
  } catch (err) {
    rows.push({ ...m, got: 'error', ms: NaN });
    console.log(`ERR  ${err.message.slice(0, 200)}`);
  }
}
const ms = rows.map((r) => r.ms).filter(Number.isFinite).sort((a, b) => a - b);
const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
const tally = (g) => { const l = rows.filter((r) => r.group === g); return `${l.filter((r) => r.got === r.emotion).length}/${l.length}`; };
console.log(`\n${model} (thinking ${thinking}): ${rows.filter((r) => r.got === r.emotion).length}/${rows.length} [both ${tally('both')}, tone ${tally('tone')}, neutral ${tally('neutral')}]`);
console.log(`latency ms: median ${q(0.5)}, p90 ${q(0.9)}, max ${ms.at(-1)}, over 2 s: ${ms.filter((x) => x > 2000).length}/${ms.length}, errors ${rows.length - ms.length}`);
