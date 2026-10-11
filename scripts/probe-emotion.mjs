// Quick look at what the text model and decide() say for any lines (offline, no quota).
// Usage: node scripts/probe-emotion.mjs "line one" "line two" ...
import { pipeline, env } from '@huggingface/transformers';
import { fileURLToPath } from 'node:url';
import { EMOTION_MODEL } from '../control/caption.js';
import { decide } from '../control/emotion-core.js';

env.allowRemoteModels = false;
env.localModelPath = fileURLToPath(new URL('../models/', import.meta.url));
const go = await pipeline('text-classification', EMOTION_MODEL, { dtype: 'q8' });
for (const text of process.argv.slice(2)) {
  const scores = await go(text, { top_k: null });
  const r = decide(Object.fromEntries(scores.map((x) => [x.label, x.score])), text, 0.5, 0.7);
  console.log(`${r.emotion.padEnd(9)} ${r.confidence.toFixed(2)}  ${scores.slice(0, 3).map((x) => `${x.label} ${x.score.toFixed(2)}`).join(', ')}  "${text}"`);
}
