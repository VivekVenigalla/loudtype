// Offline check of the emotion2vec service (emotion2vec/service.py, must be running)
// on the acted ElevenLabs emotion set in eval-data/emotion/ (make-emotion-set.mjs).
// Voice only: the words are ignored. Usage: node scripts/eval-emotion2vec.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromVoice } from '../control/emotion-core.js';

const DIR = fileURLToPath(new URL('../eval-data/emotion/', import.meta.url));
const PORT = process.env.EMOTION2VEC_PORT || 7790;
const manifest = JSON.parse(readFileSync(DIR + 'manifest.json', 'utf8'));
const tally = {};
for (const m of manifest) {
  const b = readFileSync(DIR + m.file);
  const x = new Float32Array(b.length / 2);
  for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(i * 2) / 32768;
  const r = await fetch(`http://127.0.0.1:${PORT}/emotion`, { method: 'POST', body: Buffer.from(x.buffer) });
  const { scores, ms } = await r.json();
  const got = fromVoice(scores).emotion;
  const t = (tally[m.group] ??= [0, 0]); t[1]++; if (got === m.emotion) t[0]++;
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
  console.log(`${got === m.emotion ? 'ok  ' : 'MISS'} ${m.group.padEnd(7)} ${m.emotion.padEnd(7)} → ${got.padEnd(7)} (${top}, ${ms} ms) "${m.text}"`);
}
console.log(Object.entries(tally).map(([g, [a, n]]) => `${g} ${a}/${n}`).join(', '));
