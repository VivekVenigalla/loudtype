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

test('creator hype: surprise said with an energetic voice is happy; flat it is surprised; negative is not hype', () => {
  const wow = { surprise: 0.75, excitement: 0.12, neutral: 0.1 };
  assert.equal(decide(wow, 'oh my gosh look at this', 0.8, 0.7).emotion, 'happy');
  assert.equal(decide(wow, 'oh my gosh look at this', 0.3, 0.7).emotion, 'surprised');             // said flatly
  assert.notEqual(decide({ ...wow, disgust: 0.5 }, 'oh my gosh look at this', 0.8, 0.7).emotion, 'happy'); // something negative in it: not hype
  assert.equal(decide({ neutral: 0.95 }, 'this is the one dollar room', 0.9, 0.7).emotion, 'neutral'); // no surprise in it
});

test('pure surprise is surprised; hype needs some excitement or amusement', () => {
  assert.equal(decide({ surprise: 0.85, excitement: 0.07, neutral: 0.05 }, "wow I can't believe it", 0.5, 0.7).emotion, 'surprised');
  assert.equal(decide({ surprise: 0.77, excitement: 0.12, neutral: 0.08 }, 'oh my gosh look at this', 0.5, 0.7).emotion, 'happy');
});

test('a negative line that is mostly fear is scared, mostly disgust is disgusted', () => {
  assert.equal(decide({ fear: 0.91, nervousness: 0.07, neutral: 0.03 }, "I'm so scared of this boss", 0.5, 0.7).emotion, 'scared');
  assert.equal(decide({ disgust: 0.85, annoyance: 0.05 }, 'ew that is disgusting', 0.5, 0.7).emotion, 'disgusted');
  assert.equal(decide({ anger: 0.8, disgust: 0.1 }, 'I hate this stupid level', 0.8, 0.7).emotion, 'angry');
  assert.equal(decide({ sadness: 0.8, fear: 0.1 }, 'I really miss my old dog', 0.3, 0.7).emotion, 'sad');
});

test('emotion2vec: voice labels map to emotions; neutral and unsure stay neutral', async () => {
  const { fromVoice } = await import('../control/emotion-core.js');
  assert.equal(fromVoice({ angry: 0.9, neutral: 0.1 }).emotion, 'angry');
  assert.equal(fromVoice({ disgusted: 0.6, neutral: 0.4 }).emotion, 'disgusted');
  assert.equal(fromVoice({ fearful: 0.6, sad: 0.2, neutral: 0.2 }).emotion, 'scared');
  assert.equal(fromVoice({ surprised: 0.9 }).emotion, 'surprised');
  assert.equal(fromVoice({ sad: 0.5, fearful: 0.3, neutral: 0.2 }).emotion, 'sad');
  assert.equal(fromVoice({ happy: 0.95 }, 0.7).emotion, 'happy');
  assert.equal(fromVoice({ happy: 0.95 }, 0.3).emotion, 'calm');
  assert.equal(fromVoice({ neutral: 0.8, happy: 0.2 }).emotion, 'neutral');
  assert.equal(fromVoice({ '<unk>': 0.9, sad: 0.1 }).emotion, 'neutral');
});

test('emotion2vec only colors lines whose words are neutral, and only when very sure', async () => {
  const { fuse } = await import('../control/emotion-core.js');
  const neutral = { emotion: 'neutral', confidence: 0.2, energy: 0.6 };
  const angry = { emotion: 'angry', confidence: 0.9, energy: 0.7 };
  assert.equal(fuse(neutral, null).emotion, 'neutral');
  assert.equal(fuse(neutral, { angry: 0.97, neutral: 0.03 }).emotion, 'angry');
  assert.equal(fuse(neutral, { angry: 0.7, neutral: 0.3 }).emotion, 'neutral');
  assert.equal(fuse(angry, { happy: 0.99 }).emotion, 'angry'); // the words win
});

test('sound tags color only lines the words left neutral', async () => {
  const { withSounds, soundEmotion } = await import('../control/emotion-core.js');
  const neutral = { emotion: 'neutral', confidence: 0.2 };
  assert.equal(withSounds(neutral, ['laughs']).emotion, 'happy');
  assert.equal(withSounds(neutral, ['laughs']).reason, 'heard [laughs]');
  assert.equal(withSounds(neutral, ['gasps']).emotion, 'surprised');
  assert.equal(withSounds(neutral, ['crying']).emotion, 'sad');
  assert.equal(withSounds(neutral, ['sighs']).emotion, 'neutral');            // a sigh can be relief or sadness
  assert.equal(withSounds(neutral, ['applause', 'laughter']).emotion, 'happy');
  assert.equal(withSounds({ emotion: 'angry', confidence: 0.9 }, ['laughs']).emotion, 'angry'); // the words win
  assert.equal(soundEmotion('music'), null);
});
