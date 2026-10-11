// Line emotion, on-device: GoEmotions (RoBERTa, 28 labels incl. neutral) via
// transformers.js, loaded from /models and never from the network, combined
// with voice energy in emotion-core.js. Caption text never leaves the computer.
import { transformers } from './ml.js';
import { decide, fuse, voiceEnergy, withSounds } from './emotion-core.js';
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
 * @param {Promise<Record<string, number> | null> | null} [voice]  emotion2vec scores of the line's audio (null: off)
 * @param {string[]} [sounds]  sound tags Scribe heard in the line ("laughs")
 * @returns {Promise<{emotion:string, confidence:number, energy:number, top:string, reason?:string}>}
 */
export async function classify(text, levels, tone = null, minConfidence = 0.7, taught = null, voice = null, sounds = []) {
  if (levels.length < 3 || !text.trim()) return withSounds({ emotion: 'neutral', confidence: 0, energy: 0.5, top: '' }, sounds);
  const model = await warmUp();
  const scores = await model(text, { top_k: null });
  const m = Object.fromEntries(scores.map((x) => [x.label, x.score]));
  // Energy from how the line sounded (pitch, loudness, range vs. the speaker's normal) when known, else its sizes.
  const r = withSounds(fuse(decide(m, text, tone ? toneEnergy(tone) : voiceEnergy(levels), minConfidence), await voice?.catch(() => null) ?? null), sounds);
  const top = scores.slice(0, 2).map((x) => `${x.label} ${x.score.toFixed(2)}`).join(', ')
    + (r.voice ? ` · voice ${r.voice.label} ${r.voice.confidence.toFixed(2)}` : '');
  // The speaker taught this mood and their voice clearly matches it: the voice wins, even over neutral words.
  if (taught?.confident) return { emotion: taught.emotion, confidence: Math.max(0.8, r.confidence), energy: r.energy, top, reason: `voice sounds like the taught ${taught.emotion}` };
  return { emotion: r.emotion, confidence: r.confidence, energy: r.energy, top, reason: r.reason };
}

/**
 * emotion2vec scores for a clip (16 kHz mono), from the local service via this
 * server's /emotion2vec (same origin). Null when the service isn't running.
 * @param {Float32Array | null} audio
 * @returns {Promise<Record<string, number> | null>}
 */
export async function voiceScores(audio) {
  if (!audio || audio.length < 16000 * 0.4) return null;
  const r = await fetch('/emotion2vec', { method: 'POST', body: audio.slice().buffer });
  return r.ok ? (await r.json()).scores : null;
}
