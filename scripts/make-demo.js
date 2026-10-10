// Writes replay/demo.json: a scripted caption performance that plays fully
// offline. Replace it with a real recording via "Save last session".
import { writeFileSync } from 'node:fs';
import { LEVELS } from '../control/caption.js';

const script = [
  { emotion: 'neutral', words: [['okay', 'normal'], ['chat', 'normal'], ['let\'s', 'normal'], ['try', 'normal'], ['this', 'normal']] },
  { emotion: 'calm', words: [['shh', 'whisper'], ['this', 'whisper'], ['is', 'soft'], ['the', 'whisper'], ['best', 'soft'], ['day', 'whisper'], ['ever', 'whisper']] },
  { emotion: 'happy', words: [['WE', 'loud'], ['ACTUALLY', 'shout'], ['WON', 'shout'], ['that', 'normal'], ['is', 'normal'], ['amazing', 'loud']] },
  { emotion: 'angry', words: [['no', 'loud'], ['nooooo', 'shout', 151], ['why', 'loud'], ['did', 'normal'], ['that', 'normal'], ['happen', 'shout']] },
  { emotion: 'sad', words: [['I', 'soft'], ['really', 'soft'], ['thought', 'normal'], ['we', 'soft'], ['had', 'soft'], ['it', 'whisper']] },
];

const events = [];
let t = 500;
events.push({ t: 0, msg: { type: 'calib', progress: 1 } });
script.forEach((line, i) => {
  const id = i + 1;
  const full = [];
  line.words.forEach(([word, level, wdth], k) => {
    const { size, wght } = LEVELS[level];
    full.push({ word, level, size, wght, wdth: wdth || 100 });
    t += wdth ? 900 : 320;
    events.push({ t, msg: { type: 'line', line: id, final: false, provisional: true,
      emotion: k >= 3 ? line.emotion : 'neutral', confidence: 0, words: full.map((w) => ({ ...w })) } });
  });
  t += 400;
  events.push({ t, msg: { type: 'line', line: id, final: true, provisional: false,
    emotion: line.emotion, confidence: line.emotion === 'neutral' ? 0.3 : 0.86, words: full } });
  t += 900;
});
writeFileSync(new URL('../replay/demo.json', import.meta.url), JSON.stringify({ events }, null, 1));
console.log(`replay/demo.json: ${events.length} events, ${(t / 1000).toFixed(1)} s`);
