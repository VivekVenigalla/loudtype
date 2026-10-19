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

// Runs one Expression Selector amount the way After Effects does (textIndex 1-based, time in s).
const amountAt = (expr, textIndex, time) => new Function('textIndex', 'time', `${expr.replace(/\[a, a, a\];$/, 'return [a, a, a];')}`)(textIndex, time);

test('after effects: every emotion gets its animation; neutral gets none', async () => {
  const { EMOTIONS } = await import('../control/caption.js');
  const { aeFx } = await import('../control/export.js');
  for (const e of EMOTIONS) {
    const fx = aeFx(e, [1, 1.4, 1.9]);
    if (e === 'neutral') { assert.deepEqual(fx, []); continue; }
    assert.ok(fx.length >= 1, e);
    for (const f of fx) {
      assert.match(f.prop, /^ADBE Text (Position 3D|Scale 3D|Skew|Opacity)$/);
      assert.match(f.name, new RegExp(`^Loudtype ${e} `));
      assert.match(f.amount, /^[\x20-\x7e]*$/, 'expression must be ASCII');
      assert.doesNotMatch(f.amount, /=>|`|\b(let|const)\s/, 'expression must stay ES3');
      for (let t = 0; t <= 5; t += 0.01) {
        for (const idx of [1, 2, 3]) {
          const [a, b, c] = amountAt(f.amount, idx, t);
          assert.ok(Number.isFinite(a) && a >= -100.001 && a <= 100.001 && a === b && b === c, `${f.name} at ${t}: ${a}`);
        }
      }
    }
  }
});

test('after effects: words animate from when they appear and rest like the overlay', async () => {
  const { aeFx } = await import('../control/export.js');
  const at = (e, name, idx, t) => amountAt(aeFx(e, [1, 1.4, 1.9]).find((f) => f.name.endsWith(name)).amount, idx, t)[0];
  assert.equal(at('happy', 'bounce', 2, 1.3), 0);            // word 2 appears at 1.4: still at rest before
  assert.ok(at('happy', 'bounce', 2, 1.7) > 90);             // mid-bounce 0.3 s after it appears
  assert.equal(at('angry', 'grow', 1, 9), 50);               // 50% of +12% = rests 6% bigger
  assert.equal(at('sad', 'shrink', 3, 9), 100);              // rests at 85%
  assert.equal(at('surprised', 'pop', 1, 1), 0);
  assert.ok(at('surprised', 'pop', 1, 1.01) < -85);          // starts small (about 80%)
  for (const e of ['happy', 'calm', 'scared', 'disgusted']) {
    for (const f of aeFx(e, [1, 1.4, 1.9])) assert.equal(amountAt(f.amount, 2, 9)[0], 0, `${f.name} at rest`);
  }
  // Calm: word gaps widen in step; the first word stays put, the last moves the most.
  const breathe = aeFx('calm', [1, 1.4, 1.9])[0];
  assert.deepEqual(breathe.value, [13, 0, 0]);
  assert.equal(amountAt(breathe.amount, 1, 1.8)[0], 0);
  assert.ok(amountAt(breathe.amount, 3, 1.8)[0] > 95);
  assert.ok(Math.abs(amountAt(breathe.amount, 2, 1.8)[0] - amountAt(breathe.amount, 3, 1.8)[0] / 2) < 0.01);
});

test('after effects: each line embeds its animators with its own word times (icon first)', () => {
  const data = embeddedData(toAfterEffects(LINES));
  assert.deepEqual(data.lines[0].fx, []);                                 // neutral
  assert.deepEqual(data.lines[1].fx.map((f) => f.name), ['Loudtype happy bounce']);
  assert.match(data.lines[1].fx[0].amount, /var T = \[1\.6,1\.6,2\]/);    // star, WE, WON
  const src = toAfterEffects(LINES);
  assert.match(src, /ADBE Text Expressible Selector/);
  assert.match(src, /addFx\(layer, line\.fx\)/);
});

// ---------- WebVTT and plain transcript ----------
test('vtt: a valid WebVTT file with styles for every level and emotion', async () => {
  const { toVtt } = await import('../control/export.js');
  const vtt = toVtt(LINES);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /^STYLE$/m);
  assert.match(vtt, /::cue\(\.shout\) \{[^}]*font-weight: 900/);
  assert.match(vtt, /::cue\(\.happy\) \{ color: #ffd84d; \}/);
  // STYLE must come before the first cue
  assert.ok(vtt.indexOf('STYLE') < vtt.indexOf('-->'));
});

test('vtt: each cue has its times, the emotion icon, word timings and loudness classes', async () => {
  const { toVtt } = await import('../control/export.js');
  const cues = toVtt(LINES).split('\n\n').filter((c) => c.includes('-->'));
  assert.equal(cues.length, 3);
  assert.equal(cues[0], '1\n00:00:00.500 --> 00:00:01.550\nokay <00:00:00.900>chat');
  assert.equal(cues[1], '2\n00:00:01.600 --> 00:00:04.100\n<c.happy>★ <c.loud>WE</c> <00:00:02.000><c.shout>WON</c></c>');
});

test('vtt: text that looks like markup is escaped; sound tags are italic', async () => {
  const { toVtt } = await import('../control/export.js');
  const line = { line: 1, text: '', emotion: 'neutral', confidence: 0,
    words: [w('a<b>&c', 1, 1.2), { ...w('[laughs]', 1.3, 1.6), event: 'laughs' }] };
  assert.match(toVtt([line]), /\na&lt;b&gt;&amp;c <00:00:01\.300><i>\[laughs\]<\/i>\n$/);
});

test('transcript: one timestamped line per caption, with its mood', async () => {
  const { toText } = await import('../control/export.js');
  assert.equal(toText(LINES), '[00:00] okay chat\n[00:01] (happy) WE WON\n[00:10] (calm) nice\n');
  const long = [{ ...LINES[2], words: [w('late', 3725, 3726)] }];
  assert.equal(toText(long), '[1:02:05] (calm) nice\n');
});

test('exports list lines in spoken order even if handed out of order', async () => {
  const { toVtt, toText } = await import('../control/export.js');
  const shuffled = [LINES[2], LINES[0], LINES[1]];
  assert.equal(toText(shuffled), toText(LINES));
  assert.equal(toVtt(shuffled), toVtt(LINES));
  assert.equal(toSrt(shuffled), toSrt(LINES));
});
