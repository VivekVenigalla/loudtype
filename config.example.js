// Copy to config.js and fill in your key. config.js is gitignored.
// The key stays on this computer's server and is only sent to api.elevenlabs.io.
export const CONFIG = {
  GEMINI_API_KEY: '',             // optional: Gemini emotion engine (aistudio.google.com); empty = off
  ELEVENLABS_API_KEY: 'YOUR_ELEVENLABS_API_KEY',
  STT_MODEL_ID: 'scribe_v2_realtime',
  STT_REFINE: true,              // re-transcribe each committed line with the batch model below (more accurate, ~1 s later)
  STT_BATCH_MODEL_ID: 'scribe_v2',
  EMOTION2VEC: true,             // voice emotion from emotion2vec (run: npm run emotion2vec); off if the service isn't running
  EMOTION2VEC_PORT: 7790,
  IGNORE_BACKGROUND: false,      // false: caption everyone; true: main speaker only (voiceprint filter)
  STT_ZERO_RETENTION: true,      // asks ElevenLabs not to keep audio; set false if your plan rejects it
  STREAM_DELAY_SECS: 0,          // sync mode: your stream's delay in seconds (captions land when viewers hear the words); 0 = live
  VAD_SILENCE_SECS: 0.6,         // pause that ends a caption line; lower = faster, shorter lines
  EMOTION_MIN_CONFIDENCE: 0.7,   // below this, lines stay white
  COLORBLIND_PALETTE: false,
  CAPTION_FONT: 'flex',          // subtitle font: 'flex' (Roboto Flex), 'comic' (Comic Neue), 'pro' (Inter), 'readable' (Atkinson Hyperlegible)
  REDUCE_MOTION: false,          // true: no emotion animations (color + icon only); also ?motion=reduce on the overlay URL
  STREAM_SAFE: false,            // not implemented yet: swear words are NOT filtered
  SHOUT_POP: true,
  RELAY_PORT: 7777,
};
