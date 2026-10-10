// Line emotion, on-device: GoEmotions (RoBERTa, 28 labels incl. neutral) via
// transformers.js, loaded from /models and never from the network, combined
// with voice energy in emotion-core.js. Caption text never leaves the computer.
import { pipeline, env } from '/vendor/transformers/transformers.min.js';
import { decide, voiceEnergy } from './emotion-core.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = '/vendor/ort/';
env.backends.onnx.wasm.numThreads = 1; // page isn't cross-origin isolated

const MODEL = 'SamLowe/roberta-base-go_emotions-onnx';
let clf = null;

export function warmUp() {
  clf ??= pipeline('text-classification', MODEL, { dtype: 'q8', device: 'wasm' })
    .catch((err) => { clf = null; throw err; });
  return clf;
}

/**
 * @param {string} text
 * @param {string[]} levels  per-word loudness levels
 * @returns {Promise<{emotion:string, confidence:number, energy:number, top:string}>}
 */
export async function classify(text, levels, minConfidence = 0.7) {
  if (levels.length < 3 || !text.trim()) return { emotion: 'neutral', confidence: 0, energy: 0.5, top: '' };
  const model = await warmUp();
  const scores = await model(text, { top_k: null });
  const m = Object.fromEntries(scores.map((x) => [x.label, x.score]));
  const r = decide(m, text, voiceEnergy(levels), minConfidence);
  const top = scores.slice(0, 2).map((x) => `${x.label} ${x.score.toFixed(2)}`).join(', ');
  return { emotion: r.emotion, confidence: r.confidence, energy: r.energy, top };
}
