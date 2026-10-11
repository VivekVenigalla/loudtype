// Gemini emotion judge (server side; the key never reaches the browser).
// One caption line = its audio (WAV, inline) + its words + the previous lines for
// context → one of Loudtype's emotions as JSON. Shared by server.js and
// scripts/eval-gemini.mjs. Not on by default: it sends audio and text to Google.

export const GEMINI_EMOTIONS = ['happy', 'calm', 'angry', 'sad', 'surprised', 'scared', 'disgusted', 'neutral'];

const PROMPT = `You label the emotion of one spoken line from a livestream, for live captions.
Listen to HOW it is said (tone, pitch, energy, laughter, sighs) and read WHAT is said.
Pick exactly one:
- happy: positive and energetic (excited, hype, joyful, laughing)
- calm: positive and relaxed (grateful, content, warm)
- angry: frustrated, annoyed, furious
- sad: disappointed, tired, hurt, sorry
- surprised: shocked or startled, not clearly good or bad
- scared: afraid, nervous, panicking
- disgusted: grossed out, repulsed
- neutral: no clear feeling (plain information, instructions)
If the voice and the words disagree (sarcasm, neutral words said with feeling), trust the voice.
confidence = how likely your label is right (0..1). If unsure, say neutral with low confidence.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    emotion: { type: 'STRING', enum: GEMINI_EMOTIONS },
    confidence: { type: 'NUMBER' },
    intensity: { type: 'NUMBER' },
    sarcasm: { type: 'BOOLEAN' },
  },
  required: ['emotion', 'confidence', 'intensity', 'sarcasm'],
};

/**
 * @param {{ key: string, model: string, wav: Buffer, text: string, context?: string[],
 *   thinking?: string, timeoutMs?: number }} req
 * @returns {Promise<{ emotion: string, confidence: number, intensity: number, sarcasm: boolean, ms: number }>}
 */
export async function geminiEmotion({ key, model, wav, text, context = [], thinking = 'minimal', timeoutMs = 4000 }) {
  const t = performance.now();
  const parts = [
    { text: `${PROMPT}\n\n${context.length ? `Earlier lines (context only):\n${context.map((c) => `- ${c}`).join('\n')}\n\n` : ''}Line to label: "${text}"` },
    { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
  ];
  const generationConfig = {
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: SCHEMA,
    ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}),
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${body.slice(0, 300)}`);
  const out = JSON.parse(JSON.parse(body).candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ?? '{}');
  if (!GEMINI_EMOTIONS.includes(out.emotion)) throw new Error(`Gemini gave no emotion: ${body.slice(0, 200)}`);
  return { ...out, ms: Math.round(performance.now() - t) };
}

/** 16-bit PCM (Int16 LE, 16 kHz mono) → WAV. */
export function pcm16ToWav(pcm) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
