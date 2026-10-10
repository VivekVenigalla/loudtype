import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSrt, toAfterEffects, highlightLabel } from '../control/export.js';

const w = (word, start, end, level = 'normal', size = 1) => ({ word, level, size, wght: 450, wdth: 100, start, end });
const LINES = [
  { line: 1, text: 'okay chat', emotion: 'neutral', confidence: 0.3, words: [w('okay', 0.5, 0.8), w('chat', 0.9, 1.2)] },
  { line: 2, text: 'WE WON', emotion: 'happy', confidence: 0.9, words: [w('WE', 1.6, 1.9, 'loud', 1.25), w('WON', 2.0, 2.6, 'shout', 1.6)] },
  { line: 3, text: 'nice', emotion: 'calm', confidence: 0.8, words: [w('nice', 10, 10.4)] },
];

// The data literal the generated script embeds, evaluated back into an object.
const embeddedData = (src) => new Function(`return ${src.match(/var data = (.*);\n/)[1]}`)();

test('srt: numbered cues with hh:mm:ss,mmm times and the line text', () => {
  const cues = toSrt(LINES).trim().split('\n\n');
  assert.equal(cues.length, 3);
  assert.equal(cues[0], '1\n00:00:00,500 --> 00:00:01,550\nokay chat');
  assert.match(cues[1], /^2\n00:00:01,600 --> 00:00:04,100\nWE WON$/);
});

test('srt: a caption lingers 1.5 s but never overlaps the next one', () => {
  const [first] = toSrt(LINES).split('\n\n');
  // Line 1 ends at 1.2 s; line 2 starts at 1.6 s, so it's cut to 1.55 s.
  assert.match(first, /--> 00:00:01,550/);
  assert.match(toSrt(LINES), /3\n00:00:10,000 --> 00:00:11,900\nnice/);
});

test('srt: hours and minutes roll over', () => {
  const long = [{ ...LINES[2], words: [w('late', 3725.25, 3726)] }];
  assert.match(toSrt(long), /01:02:05,250 --> 01:02:07,500/);
});

test('highlight labels name shouts and the emotion', () => {
  assert.equal(highlightLabel(LINES[0]), '');
  assert.equal(highlightLabel(LINES[1]), 'SHOUT x1 / HAPPY');
  assert.equal(highlightLabel(LINES[2]), 'CALM');
});

test('after effects: the script parses as JavaScript', () => {
  assert.doesNotThrow(() => new Function(toAfterEffects(LINES)));
});

test('after effects: generated code stays ES3 (ExtendScript)', () => {
  const code = toAfterEffects(LINES).replace(/var data = .*;\n/, '').replace(/\/\/.*$/gm, ''); // code only
  assert.doesNotMatch(code, /\b(let|const|class)\s/);
  assert.doesNotMatch(code, /=>|`|\.\.\./);
});

test('after effects: embeds timing, size, color, icon and markers per line', () => {
  const data = embeddedData(toAfterEffects(LINES));
  assert.equal(data.lines.length, 3);
  assert.deepEqual(data.lines[1].words, [{ t: 1.6, w: 'WE', s: 1.25 }, { t: 2.0, w: 'WON', s: 1.6 }]);
  assert.equal(data.lines[1].prefix, '★ ');
  assert.equal(data.lines[1].marker, 'SHOUT x1 / HAPPY');
  assert.deepEqual(data.lines[0].color, [1, 1, 1]);
  assert.deepEqual(data.lines[1].color, [1, 0.847, 0.302]); // #ffd84d, as before
  assert.deepEqual(data.lines[2].color, [0.357, 0.89, 0.549]); // #5be38c
  assert.equal(data.lines[0].end, 1.2 + 1.5);
  assert.equal(data.duration, 10.4 + 1.5 + 1);
});

test('after effects: the script is pure ASCII but keeps icons and accents', () => {
  const lines = [{ ...LINES[1], words: [w('¡olé', 1, 2, 'shout', 1.6), w('naïve😀', 2, 3)] }];
  const src = toAfterEffects(lines);
  assert.match(src, /^[\x00-\x7f]*$/, 'non-ASCII character in the .jsx');
  const data = embeddedData(src);
  assert.equal(data.lines[0].prefix, '★ ');
  assert.deepEqual(data.lines[0].words.map((x) => x.w), ['¡olé', 'naïve😀']);
});

test('after effects: an empty session still makes a valid comp', () => {
  const src = toAfterEffects([]);
  assert.doesNotThrow(() => new Function(src));
  assert.equal(embeddedData(src).duration, 10);
});
