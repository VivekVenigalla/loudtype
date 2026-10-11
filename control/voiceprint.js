// The voiceprint model in the browser: WeSpeaker ResNet34 (CC-BY-4.0, 26 MB,
// fetched once by `npm run setup`), on-device via transformers.js. ~20 ms per
// line. The logic (enrollment, thresholds) is in voiceprint-core.js.
import { transformers } from './ml.js';
import { VOICE_MODEL } from './caption.js';

const { AutoModel, AutoProcessor } = transformers;
let loaded = null;

export function loadVoiceModel() {
  loaded ??= Promise.all([
    AutoProcessor.from_pretrained(VOICE_MODEL),
    AutoModel.from_pretrained(VOICE_MODEL, { dtype: 'fp32', device: 'wasm' }),
  ]).catch((err) => { loaded = null; throw err; });
  return loaded;
}

// One embedding at a time: lines and partials can ask at once.
let queue = Promise.resolve();

/** Speaker embedding of 16 kHz mono audio. */
export function embed(audio) {
  const run = queue.then(async () => {
    const [processor, model] = await loadVoiceModel();
    const out = await model(await processor(audio));
    return out.last_hidden_state.data; // the 256-number embedding (one row)
  });
  queue = run.catch(() => {});
  return run;
}
