// Runs on the audio thread, so its timing is exact even when the page is busy
// (e.g. while the emotion model loads). Two outputs:
//   { type: 'frame', t, db, voicing }  every ~33 ms, for loudness/whisper detection
//   { type: 'chunk', t, buf }          every 100 ms of 16 kHz Int16 PCM, for speech-to-text
// `t` is the AudioContext time at the END of that audio. Audio is never stored.
import { frameFeatures } from './features.js';

const TARGET_RATE = 16000;
const CHUNK = 1600;      // 100 ms at 16 kHz
const FRAME_SEC = 0.033;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // input samples per output sample
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.out = new Int16Array(CHUNK);
    this.n = 0;
    this.frame = new Float32Array(Math.round(sampleRate * FRAME_SEC));
    this.fn = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const tEnd = currentTime + (i + 1) / sampleRate;

      // Loudness/voicing frame at full rate.
      this.frame[this.fn++] = ch[i];
      if (this.fn === this.frame.length) {
        const { db, voicing } = frameFeatures(this.frame, sampleRate);
        this.port.postMessage({ type: 'frame', t: tEnd, db, voicing });
        this.fn = 0;
      }

      // Box-filter decimation to 16 kHz (a cheap low-pass that avoids aliasing).
      this.sum += ch[i];
      this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === CHUNK) {
          this.port.postMessage({ type: 'chunk', t: tEnd, buf: this.out.buffer }, [this.out.buffer]);
          this.out = new Int16Array(CHUNK);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
