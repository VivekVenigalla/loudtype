import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
