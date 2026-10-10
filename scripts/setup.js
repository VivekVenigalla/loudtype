// One-time download of the on-device emotion and voiceprint models and the Roboto Flex
// variable font. After this, Loudtype needs the network only for ElevenLabs.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMOTION_MODEL, VOICE_MODEL } from '../control/caption.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = EMOTION_MODEL;
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

async function exists(p) { try { await access(p); return true; } catch { return false; } }

async function download(url, dest, headers = {}) {
  if (await exists(dest)) { console.log('ok      ', dest.replace(ROOT, '.')); return; }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log('fetched ', dest.replace(ROOT, '.'));
}

for (const f of MODEL_FILES) {
  await download(`https://huggingface.co/${MODEL}/resolve/main/${f}`, join(ROOT, 'models', MODEL, f));
}

// Voiceprint model (WeSpeaker ResNet34, CC-BY-4.0): captions only the calibrated voices.
for (const f of ['config.json', 'preprocessor_config.json', 'onnx/model.onnx']) {
  await download(`https://huggingface.co/${VOICE_MODEL}/resolve/main/${f}`, join(ROOT, 'models', VOICE_MODEL, f));
}

// Roboto Flex with the weight and width axes, latin subset.
const fontDest = join(ROOT, 'fonts', 'RobotoFlex.woff2');
if (!(await exists(fontDest))) {
  const css = await (await fetch('https://fonts.googleapis.com/css2?family=Roboto+Flex:wdth,wght@25..151,100..1000', { headers: { 'User-Agent': UA } })).text();
  const blocks = css.split('@font-face').filter((b) => b.includes('/* latin */') || b.includes('U+0000-00FF'));
  const url = (blocks.at(-1) || css).match(/url\((https:[^)]+\.woff2)\)/)?.[1];
  if (!url) throw new Error('Could not find Roboto Flex woff2 URL');
  await download(url, fontDest);
} else console.log('ok      ', './fonts/RobotoFlex.woff2');

console.log('Setup done.');
