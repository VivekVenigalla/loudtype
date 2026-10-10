// Mic capture. All measuring happens in the audio worklet (exact timing):
//  - onFrame(t, db, voicing, pitch) every ~33 ms for prosody (loudness, whisper, main speaker)
//  - onChunk(int16Buffer, t, rawInt16Buffer, rawEnd) every 100 ms of 16 kHz PCM: the background-gated
//    audio for speech-to-text, and the same audio before the gate (ending at rawEnd) for voiceprints
//  - setGate(db, unvoicedDb): the level speech-to-text needs to hear anything (-Infinity = off),
//    and the lower level enough for unvoiced (whisper-like) audio
// `t` is the AudioContext time at the end of that piece of audio.
import { Gate } from './gate.js';

const GATE_DELAY_SEC = new Gate({ rate: 16000 }).delaySec; // the worklet's gate, same defaults

// Auto gain / noise suppression would flatten exactly the loudness we measure.
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/**
 * source 'mic': the microphone. 'tab': the audio of a browser tab (a Twitch or
 * YouTube stream playing in Chrome), chosen in Chrome's share dialog with
 * "Also share tab audio" ticked; for testing on real streams. onEnded fires
 * when sharing stops (Chrome's "Stop sharing" bar).
 */
async function openStream(source) {
  if (source !== 'tab') return navigator.mediaDevices.getUserMedia({ audio: { ...RAW, channelCount: 1 } });
  // Chrome only shares tab audio together with video; the video track is dropped at once.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { ...RAW, suppressLocalAudioPlayback: false }, // keep hearing the stream yourself
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    systemAudio: 'include',
  });
  stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
  if (!stream.getAudioTracks().length) {
    throw new Error('No audio was shared. Pick the Twitch/YouTube tab and tick "Also share tab audio" in Chrome\'s dialog.');
  }
  return stream;
}

export async function startAudio({ onFrame, onChunk, source = 'mic', onEnded = () => {} }) {
  const stream = await openStream(source);
  stream.getAudioTracks()[0].addEventListener('ended', onEnded);
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  const input = ctx.createMediaStreamSource(stream);

  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
  // Mono: a stream's stereo is mixed down, not just its left channel.
  const worklet = new AudioWorkletNode(ctx, 'pcm-downsampler', { numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  input.connect(worklet);
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
      input.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
