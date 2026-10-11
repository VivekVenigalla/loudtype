// Turns text emotion scores + voice energy into one of Loudtype's four
// emotions (or neutral). Pure logic, shared by the app and the eval script.
//
//   Text (GoEmotions, 28 labels incl. "neutral") → positive / negative / neutral
//   Feeling energy = mostly the VOICE (whisper → low, shout → high), nudged by
//   the text (anger/excitement are high-energy words, sadness/gratitude low).
//
//   positive + energetic → happy   positive + relaxed → calm
//   negative + energetic → angry   negative + relaxed → sad
import { LEVEL_ORDER } from './caption.js';

const POS = ['admiration', 'amusement', 'approval', 'caring', 'desire', 'excitement', 'gratitude', 'joy', 'love', 'optimism', 'pride', 'relief'];
const NEG = ['anger', 'annoyance', 'disappointment', 'disapproval', 'disgust', 'embarrassment', 'fear', 'grief', 'nervousness', 'remorse', 'sadness'];
const HIGH_ENERGY = ['anger', 'annoyance', 'disgust', 'excitement', 'amusement', 'surprise', 'fear', 'nervousness', 'pride', 'joy'];
const LOW_ENERGY = ['sadness', 'grief', 'disappointment', 'remorse', 'caring', 'relief', 'gratitude', 'love', 'admiration', 'approval', 'optimism'];

// Stream slang the model was never trained on (it reads "sick" as illness).
const SLANG_POS = [
  /\blet'?s go+\b/i, /\b(so|that'?s|was|is|actually|literally) (sick|insane|crazy|cracked|goated|fire)\b/i, /\bno way\b/i,
  /\b(we'?re|we are) so back\b/i, /\bgg\b/i, /\bpog(gers)?\b/i, /\bclutch\b/i, /\bhype\b/i, /\bw(e)? won\b/i,
  /\bfinally (beat|got|did)\b/i, /\blet'?s goo+/i,
];
const SLANG_NEG = [
  /\bare you (kidding|serious)\b/i, /\bkidding me\b/i, /\bwhy (does|do|did|is) (this|that|it)\b/i,
  /\bkeeps? happening\b/i, /\bwhat the (hell|heck|f)/i, /\btrash\b/i, /\bunfair\b/i, /\bboring\b/i,
  /\bugh+\b/i, /\bno+o+\b/i, /\bwhy+y\b/i, /\bwe('re| are) (dead|done)\b/i, /\bthrew\b/i,
];
const SLANG_WEIGHT = 0.8;
// Creator hype: "oh my gosh look at this" reads as SURPRISE to GoEmotions, which is
// neither positive nor negative, so the line stayed white. Said with an energetic
// voice and nothing negative in it, it's hype: happy.
const HYPE = { surprise: 1, excitement: 0.5, amusement: 0.5 };
const HYPE_MIN = 0.3;        // surprise-ish score needed
const HYPE_ENERGY = 0.55;    // ...with at least this much voice + text energy
const HYPE_MAX_NEG = 0.3;

// The finer emotions. A negative line whose bad feeling is mostly fear reads scared, mostly
// disgust reads disgusted (instead of angry/sad). A line the words leave neutral but that
// is clearly surprised (and not said with hype energy, which reads happy) reads surprised.
export const SPECIFIC = { MIN: 0.3, SHARE: 0.5, SURPRISE: 0.45, HYPE_FUN: 0.1 };

const sum = (m, keys) => keys.reduce((a, k) => a + (m[k] || 0), 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * @param {Record<string, number>} scores  GoEmotions label → probability
 * @param {string} text
 * @param {number} voiceEnergy  0..1 from loudness levels (0.5 = normal speech)
 * @param {number} minConfidence
 */
export function decide(scores, text, voiceEnergy, minConfidence) {
  let pos = sum(scores, POS), neg = sum(scores, NEG), neu = scores.neutral || 0;
  const slangPos = SLANG_POS.some((r) => r.test(text));
  const slangNeg = SLANG_NEG.some((r) => r.test(text));
  // Slang wins over the model's literal reading ("so sick" isn't illness).
  if (slangPos && !slangNeg) { pos += SLANG_WEIGHT; neg *= 0.3; neu *= 0.3; }
  if (slangNeg && !slangPos) { neg += SLANG_WEIGHT; pos *= 0.3; neu *= 0.3; }

  const dominant = Math.max(pos, neg);
  const confidence = dominant / (pos + neg + neu + 1e-9);
  const hi = sum(scores, HIGH_ENERGY), lo = sum(scores, LOW_ENERGY);
  const textEnergy = hi + lo > 0.15 ? hi / (hi + lo) : 0.5;
  const energy = clamp(0.5 + 0.9 * (voiceEnergy - 0.5) + 0.45 * (textEnergy - 0.5), 0, 1);

  let emotion = 'neutral';
  let reason = '';
  if (neu < dominant && confidence >= minConfidence) {
    const energetic = energy >= 0.5;
    emotion = pos >= neg ? (energetic ? 'happy' : 'calm') : (energetic ? 'angry' : 'sad');
  }
  if ((emotion === 'angry' || emotion === 'sad') && !slangNeg) {
    const rawNeg = sum(scores, NEG), fear = sum(scores, ['fear', 'nervousness']), disgust = scores.disgust || 0;
    if (fear >= SPECIFIC.MIN && fear >= SPECIFIC.SHARE * rawNeg) { emotion = 'scared'; reason = 'mostly fear'; }
    else if (disgust >= SPECIFIC.MIN && disgust >= SPECIFIC.SHARE * rawNeg) { emotion = 'disgusted'; reason = 'mostly disgust'; }
  }
  const hype = Object.entries(HYPE).reduce((a, [k, w]) => a + w * (scores[k] || 0), 0);
  if (emotion === 'neutral' && hype >= HYPE_MIN && energy >= HYPE_ENERGY && neg < HYPE_MAX_NEG && !slangNeg) {
    // Pure surprise (nothing excited or amused in it) has its own emotion now.
    const fun = (scores.excitement || 0) + (scores.amusement || 0);
    emotion = fun >= SPECIFIC.HYPE_FUN ? 'happy' : 'surprised';
    reason = fun >= SPECIFIC.HYPE_FUN ? 'hype (surprise said with energy)' : 'surprise said with energy';
    return { emotion, confidence: Math.max(confidence, minConfidence), energy, pos, neg, neu, hype, reason };
  }
  const surprise = scores.surprise || 0;
  if (emotion === 'neutral' && surprise >= SPECIFIC.SURPRISE && neg < HYPE_MAX_NEG && !slangNeg) {
    return { emotion: 'surprised', confidence: Math.max(surprise, minConfidence), energy, pos, neg, neu, hype, reason: 'surprise' };
  }
  return { emotion, confidence, energy, pos, neg, neu, hype, reason };
}

/** Voice energy 0..1 from per-word levels (normal speech ≈ 0.5). */
export function voiceEnergy(levels) {
  if (!levels.length) return 0.5;
  const mean = levels.reduce((a, l) => a + LEVEL_ORDER.indexOf(l) / 4, 0) / levels.length;
  const loud = levels.filter((l) => l === 'loud' || l === 'shout').length / levels.length;
  const soft = levels.filter((l) => l === 'soft' || l === 'whisper').length / levels.length;
  return clamp(mean + 0.3 * loud - 0.3 * soft, 0, 1);
}

// emotion2vec (speech emotion from the voice itself, emotion2vec/service.py) labels →
// Loudtype's emotions. It has no "calm": happy said with low energy reads calm.
const VOICE_MAP = { angry: 'angry', disgusted: 'disgusted', happy: 'happy', surprised: 'surprised', sad: 'sad', fearful: 'scared' };

/**
 * @param {Record<string, number>} scores  emotion2vec label → probability
 * @param {number} [energy]  0..1 (0.5 = the speaker's normal); splits happy from calm
 * @returns {{ emotion: string, confidence: number, label: string }}
 */
export function fromVoice(scores, energy = 0.5) {
  const by = { happy: 0, angry: 0, sad: 0, surprised: 0, scared: 0, disgusted: 0 };
  for (const [k, v] of Object.entries(scores)) if (VOICE_MAP[k]) by[VOICE_MAP[k]] += v;
  const [best, p] = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  const label = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const neu = (scores.neutral || 0) + (scores.other || 0) + (scores['<unk>'] || 0) + (scores.unk || 0);
  if (p <= neu) return { emotion: 'neutral', confidence: p, label };
  const emotion = best === 'happy' && energy < 0.42 ? 'calm' : best;
  return { emotion, confidence: p, label };
}

// How the voice model joins the words. On the acted set (2026-10-10) the words were right on
// every line that had emotional words (16/16) and emotion2vec only 7/16 there, so a line the
// words already colored keeps its color. The voice only speaks up when the words are neutral
// and it is very sure (it is bimodal: mostly ~1.0 or ~0.0).
export const VOICE_FUSION = { MIN: 0.9 };

/**
 * @param {ReturnType<typeof decide>} r  the words' result
 * @param {Record<string, number> | null} voiceScores  emotion2vec scores (null: service off)
 */
export function fuse(r, voiceScores) {
  if (!voiceScores) return r;
  const v = fromVoice(voiceScores, r.energy);
  if (r.emotion !== 'neutral' || v.emotion === 'neutral' || v.confidence < VOICE_FUSION.MIN) return { ...r, voice: v };
  return { ...r, emotion: v.emotion, confidence: v.confidence, voice: v, reason: `voice sounds ${v.label} (emotion2vec ${v.confidence.toFixed(2)})` };
}
