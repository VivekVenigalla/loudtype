// Emotion accuracy: old SST-2 logic vs. GoEmotions + slang + voice energy.
// Run: node scripts/eval-emotion.mjs
import { pipeline, env } from '@huggingface/transformers';
import { fileURLToPath } from 'node:url';
import { EMOTION_MODEL } from '../control/caption.js';
env.allowRemoteModels = false;
env.localModelPath = fileURLToPath(new URL('../models/', import.meta.url));

const CASES = [
  ['let\'s go we actually won', 'pos'], ['that was so sick', 'pos'], ['this is the best day ever', 'pos'],
  ['thank you so much for the sub', 'pos'], ['that was actually insane', 'pos'], ['I love you chat', 'pos'],
  ['no way that worked', 'pos'], ['we are so back', 'pos'], ['that is hilarious', 'pos'], ['finally beat the boss', 'pos'],
  ['I hate this level', 'neg'], ['why does this keep happening', 'neg'], ['this boss is so annoying', 'neg'],
  ['I can\'t believe we lost again', 'neg'], ['I really miss my old dog', 'neg'], ['this game is broken', 'neg'],
  ['are you kidding me', 'neg'], ['I\'m so tired of this', 'neg'], ['that was so unfair', 'neg'], ['shut up', 'neg'],
  ['okay so we\'re going to go left here', 'neu'], ['let me check the map', 'neu'], ['the meeting is at three on tuesday', 'neu'],
  ['I need to grab some water', 'neu'], ['we have two more levels', 'neu'], ['what time is it', 'neu'],
  ['hold on let me reload', 'neu'], ['this is a new game called hollow knight', 'neu'], ['I think it is on the left', 'neu'], ['okay chat', 'neu'],
];

// Held out: written before tuning, never used to choose the slang list.
const HELD_OUT = [
  ['this stream has been so much fun', 'pos'], ['you guys are the best', 'pos'], ['oh my god that was perfect', 'pos'],
  ['we got the legendary drop', 'pos'], ['honestly proud of that run', 'pos'], ['that combo was clean', 'pos'],
  ['I keep dying to the same guy', 'neg'], ['my internet is so bad today', 'neg'], ['I am so sorry chat', 'neg'],
  ['that is the worst update ever', 'neg'], ['this lag is killing me', 'neg'], ['I feel terrible about that', 'neg'],
  ['give me one second', 'neu'], ['we need to find the key first', 'neu'], ['the shop is over there', 'neu'],
  ['i am going to switch weapons', 'neu'], ['chat what should we do next', 'neu'], ['loading the next level', 'neu'],
  ['this is level four', 'neu'], ['brb getting a snack', 'neu'],
];
const QUADRANTS = [
  ['this is the best day ever', 'whisper', 'calm'], ['this is the best day ever', 'shout', 'happy'],
  ['I hate this stupid level', 'shout', 'angry'], ['I really miss my old dog', 'whisper', 'sad'],
  ['thank you so much for the sub', 'normal', 'calm'], ['that is hilarious', 'normal', 'happy'],
  ['I hate this stupid level', 'normal', 'angry'], ['I really miss my old dog', 'normal', 'sad'],
];

const { decide, voiceEnergy } = await import(new URL('../control/emotion-core.js', import.meta.url));
const MIN = 0.7;
const go = await pipeline('text-classification', EMOTION_MODEL, { dtype: 'q8' });
// The old SST-2 model is only for comparison; skip it if it isn't downloaded.
const sst = await pipeline('text-classification', 'Xenova/distilbert-base-uncased-finetuned-sst-2-english', { dtype: 'q8' }).catch(() => null);
const VAL = { happy: 'pos', calm: 'pos', angry: 'neg', sad: 'neg', neutral: 'neu' };

async function score(text, levels) {
  const m = Object.fromEntries((await go(text, { top_k: null })).map((x) => [x.label, x.score]));
  return decide(m, text, voiceEnergy(levels), MIN);
}
async function oldValence(text) {
  if (!sst) return 'n/a';
  const [s] = await sst(text);
  const pPos = s.label === 'POSITIVE' ? s.score : 1 - s.score;
  return Math.pow(Math.abs(pPos - 0.5) * 2, 3) < MIN ? 'neu' : pPos > 0.5 ? 'pos' : 'neg';
}

for (const [name, set] of [['Tuning set', CASES], ['Held-out set', HELD_OUT]]) {
  let okOld = 0, okNew = 0;
  const misses = [];
  for (const [text, want] of set) {
    const o = await oldValence(text);
    const r = await score(text, ['normal']);
    okOld += o === want; okNew += VAL[r.emotion] === want;
    if (VAL[r.emotion] !== want) misses.push(`   ✗ "${text}" want ${want}, got ${r.emotion} (conf ${r.confidence.toFixed(2)})`);
  }
  console.log(`${name}: old ${okOld}/${set.length}   new ${okNew}/${set.length}`);
  if (misses.length) console.log(misses.join('\n'));
}
let okQ = 0;
for (const [text, level, want] of QUADRANTS) {
  const r = await score(text, Array(6).fill(level));
  okQ += r.emotion === want;
  console.log(`${r.emotion === want ? '✓' : '✗'} ${level.padEnd(8)} "${text}" → ${r.emotion} (want ${want}, energy ${r.energy.toFixed(2)})`);
}
console.log(`Voice quadrants: ${okQ}/${QUADRANTS.length}`);
