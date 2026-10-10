// Mic capture. All measuring happens in the audio worklet (exact timing):
//  - onFrame(t, db, voicing) every ~33 ms for prosody (loudness, whisper detection)
//  - onChunk(int16Buffer, t) every 100 ms of 16 kHz PCM for speech-to-text
// `t` is the AudioContext time at the end of that piece of audio.
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
    if (data.type === 'frame') onFrame(data.t, data.db, data.voicing);
    else if (data.type === 'chunk') onChunk(data.buf, data.t);
  };

  return {
    ctx,
    stop() {
      worklet.port.onmessage = null;
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
    },
  };
}
