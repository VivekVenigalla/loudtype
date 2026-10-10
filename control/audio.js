// Mic capture. All measuring happens in the audio worklet (exact timing):
//  - onFrame(t, db, voicing, pitch) every ~33 ms for prosody (loudness, whisper, main speaker)
//  - onChunk(int16Buffer, t, rawInt16Buffer, rawEnd) every 100 ms of 16 kHz PCM: the background-gated
//    audio for speech-to-text, and the same audio before the gate (ending at rawEnd) for voiceprints
//  - setGate(db, unvoicedDb): the level speech-to-text needs to hear anything (-Infinity = off),
//    and the lower level enough for unvoiced (whisper-like) audio
// `t` is the AudioContext time at the end of that piece of audio.
import { Gate } from './gate.js';

const GATE_DELAY_SEC = new Gate({ rate: 16000 }).delaySec; // the worklet's gate, same defaults

export async function startAudio({ onFrame, onChunk }) {
  // Auto gain / noise suppression would flatten exactly the loudness we measure.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);

  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
  const worklet = new AudioWorkletNode(ctx, 'pcm-downsampler', { numberOfOutputs: 0 });
  source.connect(worklet);
  worklet.port.onmessage = ({ data }) => {
    if (data.type === 'frame') onFrame(data.t, data.db, data.voicing, data.pitch);
    else if (data.type === 'chunk') onChunk(data.buf, data.t, data.raw, data.t + GATE_DELAY_SEC);
  };

  return {
    ctx,
    track: stream.getAudioTracks()[0], // for the mic report: label and what Chrome actually applied
    setGate(db, unvoicedDb = db) { worklet.port.postMessage({ type: 'gate', db, unvoicedDb }); },
    stop() {
      worklet.port.onmessage = null;
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
