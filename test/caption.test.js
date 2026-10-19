import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { LEVELS, LEVEL_ORDER, ICONS, EMOTION_COLORS } from '../control/caption.js';

test('overlay CSS colors match caption.js', () => {
  const css = readFileSync(new URL('../overlay/style.css', import.meta.url), 'utf8');
  const root = css.match(/:root\s*{([^}]*)}/)[1];
  for (const [emotion, hex] of Object.entries(EMOTION_COLORS)) {
    const m = root.match(new RegExp(`--c-${emotion}:\\s*(#[0-9a-f]{6})`, 'i'));
    assert.ok(m, `--c-${emotion} missing`);
    assert.equal(m[1].toLowerCase(), hex, emotion);
  }
});

test('levels grow in size and weight from whisper to shout', () => {
  assert.deepEqual(Object.keys(LEVELS), LEVEL_ORDER);
  for (let i = 1; i < LEVEL_ORDER.length; i++) {
    const [a, b] = [LEVELS[LEVEL_ORDER[i - 1]], LEVELS[LEVEL_ORDER[i]]];
    assert.ok(b.size > a.size && b.wght > a.wght, LEVEL_ORDER[i]);
  }
  assert.deepEqual(LEVELS.normal, { size: 1, wght: 450 });
});

test('every tinted emotion has an icon (color is never the only signal)', () => {
  for (const emotion of Object.keys(EMOTION_COLORS)) {
    assert.equal(emotion === 'neutral' ? ICONS[emotion] === '' : ICONS[emotion].length > 0, true, emotion);
  }
});

test('every emotion has a color, an animation and a CSS color class; every font a rule and a file', async () => {
  const { EMOTIONS, FONTS } = await import('../control/caption.js');
  const { FX } = await import('../overlay/fx.js');
  const css = readFileSync(new URL('../overlay/style.css', import.meta.url), 'utf8');
  assert.deepEqual(new Set(EMOTIONS), new Set(Object.keys(EMOTION_COLORS)));
  for (const e of EMOTIONS) {
    assert.ok(FX[e], `FX.${e} missing`);
    if (e !== 'neutral') {
      const frames = typeof FX[e].keyframes === 'function' ? FX[e].keyframes(3) : FX[e].keyframes;
      assert.ok(FX[e].duration > 0 && frames.length >= 2, `FX.${e} does nothing`);
      assert.match(css, new RegExp(`\\.${e}\\s*{\\s*color: var\\(--c-${e}\\)`), `.${e} color rule`);
    }
  }
  for (const id of Object.keys(FONTS)) if (id !== 'flex') assert.match(css, new RegExp(`body\\.font-${id}\\s*{`), `font-${id}`);
  for (const [, file] of css.matchAll(/url\('\/fonts\/([^']+)'\)/g)) {
    assert.ok(existsSync(new URL(`../fonts/${file}`, import.meta.url)), `fonts/${file} (npm run setup)`);
  }
});

test('angry and sad rest at the size their animation ends on (no jump when it finishes)', async () => {
  const { FX } = await import('../overlay/fx.js');
  const css = readFileSync(new URL('../overlay/style.css', import.meta.url), 'utf8');
  for (const e of ['angry', 'sad']) {
    const rest = css.match(new RegExp(`\\.w\\.${e}:not\\(\\.provisional\\)\\s*{\\s*transform: scale\\(([\\d.]+)\\)`))?.[1];
    assert.ok(rest, `.w.${e} rest size`);
    assert.match(/** @type {string} */ (FX[e].keyframes.at(-1).transform), new RegExp(`scale\\(${rest}\\)`), e);
  }
});

test('every style pack, size and position has its overlay CSS rule', async () => {
  const { PACKS, SIZES, POSITIONS, EMOTIONS } = await import('../control/caption.js');
  const css = readFileSync(new URL('../overlay/style.css', import.meta.url), 'utf8');
  for (const id of Object.keys(PACKS)) {
    if (id === 'studio') continue; // the defaults
    const rule = css.match(new RegExp(`\\.pack-${id}\\s*{([^}]*)}`))?.[1];
    assert.ok(rule, `.pack-${id}`);
    for (const e of EMOTIONS) assert.match(rule, new RegExp(`--c-${e}:`), `.pack-${id} --c-${e}`);
  }
  for (const id of Object.keys(SIZES)) if (id !== 'm') assert.match(css, new RegExp(`body\\.size-${id}\\s*{\\s*--base: ${SIZES[id].px}px`), `size-${id}`);
  assert.match(css, /:root\s*{[^}]*--base: 56px/); // m = the default
  for (const id of Object.keys(POSITIONS)) if (id !== 'bottom') assert.match(css, new RegExp(`body\\.position-${id} #stage`), `position-${id}`);
  // The colorblind palette comes after the packs, so it wins over their colors.
  assert.ok(css.indexOf('.colorblind {') > css.lastIndexOf('.pack-'));
});
