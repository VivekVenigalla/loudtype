// Builds a spoken emotion test set with ElevenLabs text-to-speech (Eleven v3
// audio tags act out the emotion), for scripts/eval-emotion-voice.mjs.
// Uses ~2,000 characters of TTS quota; run once. Output (gitignored):
// eval-data/emotion/<n>.pcm (16 kHz mono Int16) + manifest.json.
// Groups: 'both' = words and tone agree; 'tone' = neutral words, emotional
// delivery (does Loudtype hear the voice, not just the words?); 'neutral'.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const { CONFIG } = await import(new URL('config.js', ROOT).href);
const OUT = fileURLToPath(new URL('eval-data/emotion/', ROOT));
mkdirSync(OUT, { recursive: true });
const VOICES = ['JBFqnCBsd6RMkjVDRZzb', 'EXAVITQu4vr4xnSDxMaL']; // ElevenLabs default voices (George, Sarah)
const TAG = { happy: '[excited]', calm: '[calm]', angry: '[angry]', sad: '[sad]', neutral: '' };

const LINES = [
  // words and tone agree
  ['both', 'happy', "Let's go, we actually won the whole tournament!"],
  ['both', 'happy', 'No way, that was the best play I have ever seen!'],
  ['both', 'happy', 'Oh my god, chat, we finally got the legendary drop!'],
  ['both', 'happy', 'That was insane, you guys are amazing!'],
  ['both', 'calm', 'Thank you all so much for hanging out with me tonight.'],
  ['both', 'calm', 'This has been a really nice, relaxing stream.'],
  ['both', 'calm', "I'm just happy we got to play together today."],
  ['both', 'calm', 'Honestly, I really appreciate every one of you.'],
  ['both', 'angry', 'Are you kidding me? That was completely unfair!'],
  ['both', 'angry', 'I hate this stupid boss, it keeps cheating!'],
  ['both', 'angry', 'Why does this lag keep happening every single time?'],
  ['both', 'angry', 'That is the worst update they have ever made!'],
  ['both', 'sad', 'I really miss my old dog, he used to sit right here.'],
  ['both', 'sad', 'We lost again, I just feel so tired of this.'],
  ['both', 'sad', "I'm sorry chat, I don't think I can win this one."],
  ['both', 'sad', 'This is my last stream for a while, I am going to miss you.'],
  // neutral words, emotional delivery
  ...['happy', 'calm', 'angry', 'sad'].flatMap((e) => [
    ['tone', e, 'Okay, so we are going to the left side now.'],
    ['tone', e, 'The next round starts in about two minutes.'],
    ['tone', e, 'I am going to check the map real quick.'],
  ]),
  // plain neutral
  ['neutral', 'neutral', 'Okay, so we are going to the left side now.'],
  ['neutral', 'neutral', 'The next round starts in about two minutes.'],
  ['neutral', 'neutral', 'I am going to check the map real quick.'],
  ['neutral', 'neutral', 'Let me grab some water before we continue.'],
  ['neutral', 'neutral', 'This level has three keys and one door.'],
  ['neutral', 'neutral', 'We need to find the shop on the second floor.'],
  ['neutral', 'neutral', 'Hold on, I am switching to the other weapon.'],
  ['neutral', 'neutral', 'The meeting is at three on Tuesday.'],
];

const manifest = [];
let chars = 0;
for (const [i, [group, emotion, text]] of LINES.entries()) {
  const voice = VOICES[i % VOICES.length];
  const file = `${i}.pcm`;
  const input = `${TAG[emotion]} ${text}`.trim();
  manifest.push({ file, group, emotion, text, voice, input });
  if (existsSync(OUT + file)) continue;
  chars += input.length;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text: input, model_id: 'eleven_v3' }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()} (line ${i})`);
  writeFileSync(OUT + file, Buffer.from(await r.arrayBuffer()));
  process.stdout.write('.');
}
writeFileSync(OUT + 'manifest.json', JSON.stringify(manifest, null, 1));
console.log(`\n${manifest.length} clips in eval-data/emotion/ (${chars} characters generated this run)`);
