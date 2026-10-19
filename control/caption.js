// The caption grammar, shared by the control panel, the overlay, the exports
// and the scripts. overlay/style.css repeats EMOTION_COLORS as CSS variables
// (CSS can't import this); test/caption.test.js keeps the two in sync.

/**
 * What the control panel sends the overlay over the relay (`npm run typecheck`).
 * @typedef {'whisper' | 'soft' | 'normal' | 'loud' | 'shout'} Level
 * @typedef {'neutral' | 'happy' | 'calm' | 'angry' | 'sad' | 'surprised' | 'scared' | 'disgusted'} Emotion
 * @typedef {{ size: number, wght: number }} LevelStyle
 * @typedef {{ level: Level, size: number, wght: number, wdth: number }} WordStyle
 * @typedef {WordStyle & { word: string, start?: number, end?: number, event?: string }} CaptionWord
 *   event: a sound tag, not a spoken word ("laughs" for Scribe's [laughs]); `word` is then "[laughs]"
 *   start/end: seconds since the session started (committed words only)
 * @typedef {{ type: 'line', line: number, final: boolean, provisional: boolean,
 *   emotion: Emotion, confidence: number, words: CaptionWord[] }} LineEvent
 * @typedef {LineEvent
 *   | { type: 'calib', progress: number }
 *   | { type: 'pack', pack: PackId }
 *   | { type: 'layout', size: SizeId, position: PositionId }
 *   | { type: 'font', font: FontId }
 *   | { type: 'motion', reduce: boolean }
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
export const ICONS = { happy: '★', calm: '●', angry: '▲', sad: '▼', surprised: '!', scared: '◇', disgusted: '✕', neutral: '' };
/** @type {Record<Emotion, string>} */
export const EMOTION_COLORS = {
  neutral: '#ffffff', happy: '#ffd84d', calm: '#5be38c', angry: '#ff4d4d', sad: '#5aa9ff',
  surprised: '#ff9f43', scared: '#b388ff', disgusted: '#a8b545',
};
/** @type {Emotion[]} */
export const EMOTIONS = ['happy', 'calm', 'angry', 'sad', 'surprised', 'scared', 'disgusted', 'neutral'];

// Subtitle fonts (all on this computer, fonts/). overlay/style.css has a .font-<id> rule for each.
/** @typedef {'flex' | 'comic' | 'pro' | 'readable'} FontId */
/** @type {Record<FontId, string>} */
export const FONTS = {
  flex: 'Roboto Flex (default)',
  comic: 'Comic Neue (playful)',
  pro: 'Inter (professional)',
  readable: 'Atkinson Hyperlegible (easiest to read)',
};

// Style packs: palette, outline and shadow only; the type grammar (size, weight,
// width, color+icon meanings) is the same in every pack. overlay/style.css has a .pack-<id> rule for each.
/** @typedef {'studio' | 'arcade' | 'ink'} PackId */
/** @type {Record<PackId, string>} */
export const PACKS = {
  studio: 'Studio (white text, black outline)',
  arcade: 'Arcade (neon, hard pixel shadow)',
  ink: 'Ink (dark text, for bright video)',
};

// Caption size (the normal word's size) and where the captions sit. Also ?size= and ?position= on the overlay URL.
/** @typedef {'s' | 'm' | 'l' | 'xl'} SizeId */
/** @type {Record<SizeId, { label: string, px: number }>} */
export const SIZES = { s: { label: 'Small', px: 44 }, m: { label: 'Medium', px: 56 }, l: { label: 'Large', px: 72 }, xl: { label: 'Extra large', px: 90 } };
/** @typedef {'bottom' | 'top'} PositionId */
/** @type {Record<PositionId, string>} */
export const POSITIONS = { bottom: 'Bottom', top: 'Top' };

// GoEmotions (28 labels incl. neutral), run on-device from models/.
export const EMOTION_MODEL = 'SamLowe/roberta-base-go_emotions-onnx';
/** On-device speaker-embedding model (voiceprints), see control/voiceprint.js. */
export const VOICE_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
