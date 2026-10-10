// decide() with fixed GoEmotions scores, so no model is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, voiceEnergy } from '../control/emotion-core.js';

const MIN = 0.7;
const QUIET = 0, NORMAL = 0.5, LOUD = 1; // voice energy

test('voiceEnergy: normal speech is 0.5, whispers lower, shouts higher', () => {
  assert.equal(voiceEnergy([]), 0.5);
  assert.equal(voiceEnergy(['normal', 'normal']), 0.5);
  assert.equal(voiceEnergy(['whisper', 'whisper']), 0);
  assert.equal(voiceEnergy(['shout', 'shout']), 1);
  assert.ok(voiceEnergy(['normal', 'loud', 'shout']) > 0.5);
  assert.ok(voiceEnergy(['normal', 'soft', 'whisper']) < 0.5);
});

test('same positive words: loud is happy, quiet is calm', () => {
  const joy = { joy: 0.9, neutral: 0.05 };
  assert.equal(decide(joy, 'this is the best day ever', LOUD, MIN).emotion, 'happy');
  assert.equal(decide(joy, 'this is the best day ever', QUIET, MIN).emotion, 'calm');
});

test('same negative words: loud is angry, quiet is sad', () => {
  const sad = { sadness: 0.9, neutral: 0.05 };
  assert.equal(decide(sad, 'I really miss my old dog', LOUD, MIN).emotion, 'angry');
  assert.equal(decide(sad, 'I really miss my old dog', QUIET, MIN).emotion, 'sad');
});

test('text energy nudges the voice: anger at normal volume is angry', () => {
  assert.equal(decide({ anger: 0.9, neutral: 0.05 }, 'I hate this level', NORMAL, MIN).emotion, 'angry');
  assert.equal(decide({ gratitude: 0.9, neutral: 0.05 }, 'thank you so much', NORMAL, MIN).emotion, 'calm');
});

test('stays white (neutral) when neutral dominates or confidence is low', () => {
  assert.equal(decide({ neutral: 0.9, joy: 0.05 }, 'let me check the map', LOUD, MIN).emotion, 'neutral');
  const mixed = { joy: 0.4, anger: 0.35, neutral: 0.1 };
  const r = decide(mixed, 'well that happened', LOUD, MIN);
  assert.ok(r.confidence < MIN);
  assert.equal(r.emotion, 'neutral');
  assert.equal(decide(mixed, 'well that happened', LOUD, 0.3).emotion, 'happy'); // lower bar tints it
});

test('stream slang overrides the literal reading', () => {
  const illness = { sadness: 0.6, neutral: 0.3 }; // the model reads "sick" as illness
  assert.ok(['happy', 'calm'].includes(decide(illness, 'that was so sick', NORMAL, MIN).emotion));
  const fine = { approval: 0.5, neutral: 0.4 };
  assert.ok(['angry', 'sad'].includes(decide(fine, 'are you kidding me', NORMAL, MIN).emotion));
});

test('slang in both directions cancels out', () => {
  const r = decide({ neutral: 0.9 }, "let's go, are you kidding me", NORMAL, MIN);
  assert.equal(r.emotion, 'neutral');
});

test('energy is clamped to 0..1', () => {
  for (const v of [QUIET, NORMAL, LOUD]) {
    const { energy } = decide({ excitement: 1 }, 'x', v, MIN);
    assert.ok(energy >= 0 && energy <= 1);
  }
});

test('creator hype: surprise said with an energetic voice is happy; flat or negative is not', () => {
  const wow = { surprise: 0.75, excitement: 0.12, neutral: 0.1 };
  assert.equal(decide(wow, 'oh my gosh look at this', 0.8, 0.7).emotion, 'happy');
  assert.equal(decide(wow, 'oh my gosh look at this', 0.3, 0.7).emotion, 'neutral');               // said flatly
  assert.notEqual(decide({ ...wow, disgust: 0.5 }, 'oh my gosh look at this', 0.8, 0.7).emotion, 'happy'); // something negative in it: not hype
  assert.equal(decide({ neutral: 0.95 }, 'this is the one dollar room', 0.9, 0.7).emotion, 'neutral'); // no surprise in it
});
