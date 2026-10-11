// One animation per emotion, played once when a word's line gets its final emotion.
// Shared by the overlay (render.js) and the preview page (preview.html).
//
// Web Animations (element.animate), not CSS classes: the overlay re-lays out its
// rows as words arrive, which moves word elements around the DOM. That restarts
// CSS animations; script animations keep running. Lengths are in em, so every
// font and word size moves in proportion. Words stay on their baseline at rest.
// Angry stays slightly bigger after its shake and sad slightly smaller after it sinks
// (style.css, .w.angry / .w.sad); their last keyframe matches, so nothing jumps.

/**
 * @typedef {{ keyframes: Keyframe[] | ((index: number) => Keyframe[]), duration: number, easing?: string,
 *   stagger: number, together?: boolean, icon?: Keyframe[], about: string }} Fx
 *   keyframes as a function: per word, by its place in the line (calm spreads words apart).
 *   together: every word at the same moment, the fade-in too (no word-by-word stagger).
 */

// Calm "breathes": word i slides right by i × BREATH em and back, so the gaps between
// words widen and close twice. Transform only, so the row never reflows.
const BREATH = 0.09;
const breathe = (i) => [
  { transform: 'translateX(0)', filter: 'drop-shadow(0 0 0 currentColor)' },
  { transform: `translateX(${(i * BREATH).toFixed(3)}em)`, filter: 'drop-shadow(0 0 0.18em currentColor)', offset: 0.25 },
  { transform: 'translateX(0)', filter: 'drop-shadow(0 0 0 currentColor)', offset: 0.5 },
  { transform: `translateX(${(i * BREATH).toFixed(3)}em)`, filter: 'drop-shadow(0 0 0.18em currentColor)', offset: 0.75 },
  { transform: 'translateX(0)', filter: 'drop-shadow(0 0 0 currentColor)' },
];

/** @type {Record<string, Fx>} */
export const FX = {
  angry: {
    about: 'grows about 10%, shakes sideways 3 times with a red glow, settles 6% bigger',
    duration: 520, stagger: 20, easing: 'linear',
    keyframes: [
      { transform: 'scale(1) translateX(0)', filter: 'drop-shadow(0 0 0 currentColor)' },
      { transform: 'scale(1.12) translateX(-0.06em)', filter: 'drop-shadow(0 0 0.22em currentColor)', offset: 0.15 },
      { transform: 'scale(1.1) translateX(0.06em)', offset: 0.3 },
      { transform: 'scale(1.09) translateX(-0.05em)', offset: 0.45 },
      { transform: 'scale(1.08) translateX(0.04em)', offset: 0.6 },
      { transform: 'scale(1.07) translateX(-0.02em)', filter: 'drop-shadow(0 0 0.12em currentColor)', offset: 0.75 },
      { transform: 'scale(1.06) translateX(0)', filter: 'drop-shadow(0 0 0 currentColor)' },
    ],
  },
  happy: {
    about: 'each word bounces up in turn (a wave across the line); the star spins',
    duration: 600, stagger: 70, easing: 'ease-out',
    keyframes: [
      { transform: 'translateY(0)' },
      { transform: 'translateY(-0.2em)', offset: 0.35 },
      { transform: 'translateY(0.03em)', offset: 0.7 },
      { transform: 'translateY(0)' },
    ],
    icon: [
      { transform: 'scale(1) rotate(0deg)' },
      { transform: 'scale(1.5) rotate(72deg)', offset: 0.4 },
      { transform: 'scale(1) rotate(144deg)' },
    ],
  },
  sad: {
    about: 'slow fade, each word sinks and shrinks, then stays 15% smaller',
    duration: 950, stagger: 60, easing: 'ease-out',
    keyframes: [
      { transform: 'translateY(-0.12em) scale(1)', opacity: 0.25 },
      { transform: 'translateY(0.07em) scale(0.83)', opacity: 0.9, offset: 0.7 },
      { transform: 'translateY(0) scale(0.85)', opacity: 1 },
    ],
  },
  calm: {
    about: 'breathes: the words spread apart and come back together, twice, with a soft glow',
    duration: 3200, stagger: 0, together: true, easing: 'ease-in-out', // in step, or the gaps wobble
    keyframes: breathe,
  },
  surprised: {
    about: 'every word pops at the same moment, small to big and back, with a bright flash',
    duration: 400, stagger: 0, together: true, easing: 'ease-out',
    keyframes: [
      { transform: 'scale(0.8)', filter: 'brightness(1.8)' },
      { transform: 'scale(1.18)', filter: 'brightness(1.5)', offset: 0.45 },
      { transform: 'scale(1)', filter: 'brightness(1)' },
    ],
  },
  scared: {
    about: 'small, fast tremble that flickers, then holds still',
    duration: 700, stagger: 0, easing: 'linear',
    keyframes: [
      { transform: 'translate(0, 0)', opacity: 1 },
      { transform: 'translate(-0.03em, 0.02em)', opacity: 0.6, offset: 0.1 },
      { transform: 'translate(0.03em, -0.02em)', opacity: 1, offset: 0.2 },
      { transform: 'translate(-0.025em, -0.015em)', opacity: 0.7, offset: 0.3 },
      { transform: 'translate(0.025em, 0.02em)', opacity: 1, offset: 0.4 },
      { transform: 'translate(-0.02em, 0)', opacity: 0.75, offset: 0.5 },
      { transform: 'translate(0.02em, 0.01em)', opacity: 1, offset: 0.6 },
      { transform: 'translate(-0.01em, -0.01em)', opacity: 0.85, offset: 0.75 },
      { transform: 'translate(0, 0)', opacity: 1 },
    ],
  },
  disgusted: {
    about: 'leans back (slants away), wobbles, then stands up straight',
    duration: 620, stagger: 40, easing: 'ease-out',
    keyframes: [
      { transform: 'skewX(0deg) translateX(0)' },
      { transform: 'skewX(-14deg) translateX(-0.06em)', offset: 0.35 },
      { transform: 'skewX(5deg) translateX(0.02em)', offset: 0.7 },
      { transform: 'skewX(0deg) translateX(0)' },
    ],
  },
  neutral: { about: 'plain fade-in, no motion', duration: 0, stagger: 0, keyframes: [] },
};

// Sound tags ([laughs]) get their own small motion instead of the line's.
/** @type {[RegExp, Fx][]} */
export const SOUND_FX = [
  [/^(laugh|laughs|laughing|laughter|giggles?|giggling|chuckles?|chuckling)$/, {
    about: 'laughter: two quick small hops', duration: 560, stagger: 0, easing: 'ease-in-out',
    keyframes: [
      { transform: 'translateY(0)' }, { transform: 'translateY(-0.18em)', offset: 0.22 },
      { transform: 'translateY(0)', offset: 0.45 }, { transform: 'translateY(-0.12em)', offset: 0.7 },
      { transform: 'translateY(0)' },
    ],
  }],
];

/** Plays a sound tag's motion ("laughs"); false if that sound has none (it then takes the line's). */
export function playSoundFx(el, name, delay = 0) {
  const fx = SOUND_FX.find(([re]) => re.test(name))?.[1];
  if (!fx || typeof el.animate !== 'function') return false;
  el.animate(/** @type {Keyframe[]} */ (fx.keyframes), { duration: fx.duration, easing: fx.easing, delay, fill: 'backwards' }).id = 'fx';
  return true;
}

/**
 * Plays `emotion`'s animation on one word (or the line's icon).
 * @param {HTMLElement} el
 * @param {string} emotion
 * @param {{ index?: number, icon?: boolean, delay?: number }} [opts]  index: the word's place in its line (stagger)
 * @returns {Animation | null}
 */
export function playFx(el, emotion, { index = 0, icon = false, delay = 0 } = {}) {
  const fx = FX[emotion];
  if (!fx?.duration || typeof el.animate !== 'function') return null;
  const frames = typeof fx.keyframes === 'function' ? fx.keyframes(icon ? 0 : index) : fx.keyframes;
  const keyframes = icon ? fx.icon ?? frames : frames;
  for (const a of el.getAnimations?.() ?? []) if (a.id === 'fx') a.cancel(); // a new emotion replaces the old one
  const anim = el.animate(keyframes, {
    duration: fx.duration, easing: fx.easing ?? 'ease', delay: fx.together ? 0 : delay + (icon ? 0 : index * fx.stagger), fill: 'backwards', // hold the first frame while waiting its turn
  });
  anim.id = 'fx';
  return anim;
}
