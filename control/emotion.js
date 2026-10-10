// Line emotion, on-device: GoEmotions (RoBERTa, 28 labels incl. neutral) via
// transformers.js, loaded from /models and never from the network, combined
// with voice energy in emotion-core.js. Caption text never leaves the computer.
import { transformers } from './ml.js';
import { decide, voiceEnergy } from './emotion-core.js';
import { toneEnergy } from './tone.js';
import { EMOTION_MODEL } from './caption.js';

const { pipeline } = transformers;

let clf = null;

export function warmUp() {
  clf ??= pipeline('text-classification', EMOTION_MODEL, { dtype: 'q8', device: 'wasm' })
    .catch((err) => { clf = null; throw err; });
  return clf;
}

/**
 * @param {string} text
 * @param {string[]} levels  per-word loudness levels
 * @param {object | null} tone  tone.js toneFeatures of the line (null: use levels)
 * @param {number} [minConfidence]
 * @param {{ emotion: string, confident: boolean } | null} [taught]  ToneBook.match(): the speaker's taught mood it sounds like
 * @returns {Promise<{emotion:string, confidence:number, energy:number, top:string, reason?:string}>}
 */
export async function classify(text, levels, tone = null, minConfidence = 0.7, taught = null) {
  if (levels.length < 3 || !text.trim()) return { emotion: 'neutral', confidence: 0, energy: 0.5, top: '' };
  const model = await warmUp();
  const scores = await model(text, { top_k: null });
  const m = Object.fromEntries(scores.map((x) => [x.label, x.score]));
  // Energy from how the line sounded (pitch, loudness, range vs. the speaker's normal) when known, else its sizes.
  const r = decide(m, text, tone ? toneEnergy(tone) : voiceEnergy(levels), minConfidence);
  const top = scores.slice(0, 2).map((x) => `${x.label} ${x.score.toFixed(2)}`).join(', ');
  // The speaker taught this mood and their voice clearly matches it: the voice wins, even over neutral words.
  if (taught?.confident) return { emotion: taught.emotion, confidence: Math.max(0.8, r.confidence), energy: r.energy, top, reason: `voice sounds like the taught ${taught.emotion}` };
  return { emotion: r.emotion, confidence: r.confidence, energy: r.energy, top, reason: r.reason };
}
