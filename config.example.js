// Copy to config.js and fill in your key. config.js is gitignored.
// The key stays on this computer's server and is only sent to api.elevenlabs.io.
export const CONFIG = {
  ELEVENLABS_API_KEY: 'YOUR_ELEVENLABS_API_KEY',
  STT_MODEL_ID: 'scribe_v2_realtime',
  IGNORE_BACKGROUND: true,       // caption only the main speaker; chatter, nearby people and noise are ignored
  STT_ZERO_RETENTION: true,      // asks ElevenLabs not to keep audio; set false if your plan rejects it
  VAD_SILENCE_SECS: 0.6,         // pause that ends a caption line; lower = faster, shorter lines
  EMOTION_MIN_CONFIDENCE: 0.7,   // below this, lines stay white
  COLORBLIND_PALETTE: false,
  STREAM_SAFE: false,            // not implemented yet: swear words are NOT filtered
  SHOUT_POP: true,
  RELAY_PORT: 7777,
};
