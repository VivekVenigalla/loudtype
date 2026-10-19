import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSwear, maskWord, maskLine, maskExportLine, MASK } from '../control/safe.js';
import { LEVELS } from '../control/caption.js';

test('swear words, their forms and slurs are caught, in any case and with punctuation', () => {
  for (const w of ['fuck', 'FUCKING', 'Fucked,', 'motherfucker!', 'shit', 'bullshit.', 'shitty', 'bitch', 'asshole', 'dumbass',
    'bastard', 'dick', 'dickhead', 'cunt', 'cocksucker', 'whore', 'pissed', 'wanker', "fuckin'", 'f***', 'sh*t**',
    'faggot', 'retarded', 'nigga']) {
    assert.ok(isSwear(w), w);
  }
});

test('innocent words that contain one are never touched (no Scunthorpe problem)', () => {
  for (const w of ['class', 'assist', 'assassin', 'pass', 'grass', 'Dickens', 'dickinson', 'cocktail', 'peacock', 'Scunthorpe',
    'shitake', 'shift', 'shirt', 'bass', 'cockpit', 'hello', 'buttress', 'therapist', 'mishit', 'spice', 'spick', 'kick',
    'snigger', 'fact', 'Hancock', 'title', 'analysis', 'damn', 'hell', 'crap', '']) {
    assert.ok(!isSwear(w), w);
  }
});

test('masking keeps the punctuation around the word', () => {
  assert.equal(maskWord('fucking,'), `${MASK},`);
  assert.equal(maskWord('"Shit!"'), `"${MASK}!"`);
  assert.equal(maskWord('(bitch)'), `(${MASK})`);
  assert.equal(maskWord('class.'), 'class.');
});

test('a caption line keeps each word\'s size, weight and timing; sound tags stay', () => {
  const shout = { word: 'FUCK!', level: 'shout', ...LEVELS.shout, wdth: 100, start: 1, end: 1.4 };
  const laugh = { word: '[laughs]', event: 'laughs', level: 'normal', ...LEVELS.normal, wdth: 100 };
  const msg = { type: 'line', line: 3, final: true, provisional: false, emotion: 'angry', confidence: 0.9,
    words: [{ word: 'oh', level: 'normal', ...LEVELS.normal, wdth: 100 }, shout, laugh] };
  const out = maskLine(msg);
  assert.equal(out.words[1].word, `${MASK}!`);
  assert.equal(out.words[1].size, LEVELS.shout.size);
  assert.equal(out.words[1].wght, LEVELS.shout.wght);
  assert.equal(out.words[1].start, 1);
  assert.equal(out.words[2], laugh);
  assert.equal(out.emotion, 'angry');
  assert.equal(msg.words[1].word, 'FUCK!'); // the original is not changed
  const clean = { ...msg, words: [msg.words[0]] };
  assert.equal(maskLine(clean), clean); // nothing to mask: same object
  assert.equal(maskLine({ type: 'clear' }).type, 'clear');
});

test('exported lines are masked in their words and their text', () => {
  const line = { line: 1, text: 'What the fuck, man', emotion: 'angry', confidence: 1,
    words: ['What', 'the', 'fuck,', 'man'].map((word, i) => ({ word, level: 'normal', start: i, end: i + 0.5 })) };
  const out = maskExportLine(line);
  assert.equal(out.text, `What the ${MASK}, man`);
  assert.deepEqual(out.words.map((w) => w.word), ['What', 'the', `${MASK},`, 'man']);
  assert.equal(line.text, 'What the fuck, man');
});
