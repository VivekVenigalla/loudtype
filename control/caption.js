// The caption grammar, shared by the control panel, the overlay, the exports
// and the scripts. overlay/style.css repeats EMOTION_COLORS as CSS variables
// (CSS can't import this); test/caption.test.js keeps the two in sync.

/**
 * What the control panel sends the overlay over the relay (`npm run typecheck`).
 * @typedef {'whisper' | 'soft' | 'normal' | 'loud' | 'shout'} Level
 * @typedef {'neutral' | 'happy' | 'calm' | 'angry' | 'sad'} Emotion
 * @typedef {{ size: number, wght: number }} LevelStyle
 * @typedef {{ level: Level, size: number, wght: number, wdth: number }} WordStyle
 * @typedef {WordStyle & { word: string, start?: number, end?: number, speaker?: number }} CaptionWord
 *   start/end: seconds since the session started (committed words only)
 * @typedef {{ type: 'line', line: number, final: boolean, provisional: boolean,
 *   emotion: Emotion, confidence: number, words: CaptionWord[] }} LineEvent
 * @typedef {LineEvent
 *   | { type: 'calib', progress: number }
 *   | { type: 'pack', pack: string }
 *   | { type: 'prompt', text: string, step: number, of: number }
 *   | { type: 'clear' }} CaptionEvent
 */

// Loudness level → size (× the normal size) and weight.
/** @type {Record<Level, LevelStyle>} */
export const LEVELS = {
  whisper: { size: 0.75, wght: 220 },
  soft:    { size: 0.9,  wght: 350 },
  normal:  { size: 1.0,  wght: 450 },
  loud:    { size: 1.25, wght: 700 },
  shout:   { size: 1.6,  wght: 1000 },
};
/** @type {Level[]} */
export const LEVEL_ORDER = ['whisper', 'soft', 'normal', 'loud', 'shout'];

// Color is never the only signal: every tinted line also gets its icon.
/** @type {Record<Emotion, string>} */
export const ICONS = { happy: '★', calm: '●', angry: '▲', sad: '▼', neutral: '' };
/** @type {Record<Emotion, string>} */
export const EMOTION_COLORS = { neutral: '#ffffff', happy: '#ffd84d', calm: '#5be38c', angry: '#ff4d4d', sad: '#5aa9ff' };

// GoEmotions (28 labels incl. neutral), run on-device from models/.
export const EMOTION_MODEL = 'SamLowe/roberta-base-go_emotions-onnx';
