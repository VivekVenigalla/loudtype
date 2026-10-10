// ElevenLabs Scribe realtime over WebSocket.
// Audio chunks are sent and dropped; nothing is buffered if the socket is down.
const STT_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * handlers: onOpen, onPartial(text), onCommitted(text), onCommittedTimed({text, words}),
 *           onWarning(message), onError(message), onClose()
 */
export async function openScribe({ modelId, zeroRetention, vadSilenceSecs }, h) {
  const res = await fetch('/token');
  const body = await res.json().catch(() => ({})); // e.g. an HTML error page
  if (!res.ok || !body.token) throw new Error(body.error || `Could not get a speech-to-text token (server answered ${res.status})`);

  const params = new URLSearchParams({
    model_id: modelId || 'scribe_v2_realtime',
    token: body.token,
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    include_timestamps: 'true',
  });
  if (zeroRetention) params.set('enable_logging', 'false');
  // Shorter silence before a line commits = final styling and emotion sooner.
  if (vadSilenceSecs) params.set('vad_silence_threshold_secs', String(vadSilenceSecs));

  const ws = new WebSocket(`${STT_URL}?${params}`);
  let closedByUs = false;

  ws.onopen = () => h.onOpen?.();
  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    switch (d.message_type) {
      case 'session_started': break;
      case 'partial_transcript': h.onPartial?.(d.text || ''); break;
      case 'committed_transcript': h.onCommitted?.(d.text || ''); break;
      case 'committed_transcript_with_timestamps':
        h.onCommittedTimed?.({ text: d.text || '', words: (d.words || []).filter((w) => w.type === 'word') });
        break;
      case 'warning': h.onWarning?.(d.warning || d.message || 'warning'); break;
      default:
        if (d.error || /error|exceeded|limited|overflow|exhausted|invalid|unaccepted/.test(d.message_type || '')) {
          h.onError?.(`${d.message_type}: ${d.error || d.message || ''}`);
        }
    }
  };
  ws.onerror = () => h.onError?.('Speech-to-text connection failed');
  ws.onclose = (e) => { if (!closedByUs) h.onClose?.(e.reason || `closed (${e.code})`); };

  return {
    sendChunk(buffer) {
      if (ws.readyState !== WebSocket.OPEN) return false; // drop, never buffer
      ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: toBase64(buffer),
        commit: false,
        sample_rate: 16000,
      }));
      return true;
    },
    close() { closedByUs = true; try { ws.close(1000); } catch {} },
  };
}
