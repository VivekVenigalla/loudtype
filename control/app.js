// Control panel: listens, analyzes, and tells the overlay what to draw.
import { startAudio } from './audio.js';
import { openScribe } from './stt.js';
import { Prosody, THRESHOLDS } from './prosody.js';
import { Transcript } from './transcript.js';
import { classify, warmUp, voiceScores } from './emotion.js';
import { embed, loadVoiceModel } from './voiceprint.js';
import { AudioRing, Voiceprints, VOICE, STRICTNESS } from './voiceprint-core.js';
import { Relay } from './relay.js';
import { CaptionSync } from './sync.js';
import { download, toSrt, toAfterEffects } from './export.js';
import { FONTS } from './caption.js';

const $ = (id) => document.getElementById(id);
const ui = {
  start: $('start'), stop: $('stop'), status: $('status'), meter: $('meter-fill'),
  pack: $('pack'), saveReplay: $('save-replay'), playDemo: $('play-demo'), playLast: $('play-last'),
  srt: $('export-srt'), ae: $('export-ae'), log: $('log'), calib: $('calib'),
  newJudge: $('new-judge'), mood: $('mood'), prompt: $('prompt'), promptPrev: $('prompt-prev'),
  promptNext: $('prompt-next'), promptHide: $('prompt-hide'), director: $('director'),
  dvLive: $('dv-live'), dvRef: $('dv-ref'), dvWord: $('dv-word'), dvLine: $('dv-line'), dvTicks: $('dv-ticks'),
  dvMic: $('dv-mic'), dvRoom: $('dv-room'), dvVoice: $('dv-voice'), dvCopy: $('dv-copy'), dvAudio: $('dv-audio'), focus: $('focus'),
  font: $('font'), reduceMotion: $('reduce-motion'), delay: $('delay'), delayInfo: $('delay-info'),
  strictness: $('strictness'), source: $('source'), sensitivity: $('sensitivity'), sensitivityValue: $('sensitivity-value'),
};

let config = { EMOTION_MIN_CONFIDENCE: 0.7, STT_ZERO_RETENTION: true, STT_MODEL_ID: 'scribe_v2_realtime' };
const relay = new Relay();
// Per-browser conveniences (font, motion, delay); never required: storage can be blocked.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
let session = null; // the running session
let latest = null;  // the newest session, running or stopped: what Export and the log show
let lastRecording = null;
let stopReplay = null;
let emotionReady = false;
let voiceReady = false; // voiceprint model loaded
let forcedMood = null; // creator override from hotkeys; null = automatic

fetch('/config').then((r) => r.json()).then((c) => {
  config = { ...config, ...c };
  ui.focus.checked = config.IGNORE_BACKGROUND === true; // default: caption everyone
  applyLookDefaults(); // config's CAPTION_FONT / REDUCE_MOTION, unless chosen in this browser
  if (store.get('loudtype.delay') == null) ui.delay.value = String(config.STREAM_DELAY_SECS ?? 0);
  sendLook();
}).catch(() => {});

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = kind;
}

// ---------- session ----------
async function start() {
  ui.start.disabled = true;
  ui.focus.disabled = true; // the mode is fixed for a session
  ui.source.disabled = true;
  setStatus('Starting…');
  stopReplay?.();
  relay.resetRecording();
  relay.send({ type: 'clear' });
  ui.log.textContent = '';

  const s = { prosody: new Prosody(), transcript: null, audio: null, stt: null, retries: 0, lastError: null, mic: null, gateSent: null, voice: null };
  // Voiceprints: only the calibrated voices are captioned. Audio stays in memory (last 60 s).
  s.voiceprints = new Voiceprints({ embed, ring: new AudioRing() });
  s.prosody.focus = ui.focus.checked; // off (default): everyone is captioned, no voiceprint filter
  s.voiceprints.strictness = ui.strictness.value;
  s.prosody.sensitivity = Number(ui.sensitivity.value);
  s.voiceHistory = []; // last lines' voiceprint verdicts, for the mic report
  // Sync mode: holds each finished line until the delayed stream says its words (sync.js).
  // Pending lines still go out after Stop: viewers are seconds behind.
  s.sync = new CaptionSync({
    // A line from an older session can still be classifying after Start; it
    // must not reach the new session's overlay, log or recording.
    out: (msg) => { if (latest === s) relay.send(msg); },
    now: () => s.audio?.ctx.currentTime ?? 0,
    origin: () => s.transcript?.origin ?? null,
    lag: () => s.transcript?.partialLag() ?? 0.8,
    delay: streamDelay(),
  });
  s.transcript = new Transcript({
    prosody: s.prosody,
    send: (msg) => { if (latest === s) s.sync.send(msg); },
    classify: (text, levels, tone, taught, span, sounds) => (emotionReady ? classify(text, levels, tone, config.EMOTION_MIN_CONFIDENCE, taught,
      // emotion2vec hears the line's audio (pre-gate, from memory), when its local service runs
      config.EMOTION2VEC !== false && span ? voiceScores(s.voiceprints.ring.slice(span.start - 0.1, span.end + 0.2)) : null, sounds) : null),
    // While a "teach" card is up, the line shows the mood being taught (feedback that it was heard).
    mood: () => forcedMood ?? teachingMood(),
    // Second pass through ElevenLabs' batch Scribe v2 (more accurate words; ~1 s later, fine for delayed streams).
    refine: config.STT_REFINE !== false ? (start, end) => refineLine(s, start, end) : null,
    identify: (start, end, live) => (voiceReady ? s.voiceprints.identify(s.prosody, start, end, live) : null),
    onStyled: (voice) => {
      if (voiceReady) s.voiceprints.refresh(s.prosody); // learn the voiceprint from the calibration words
      if (voice) {
        s.voice = voice;
        s.voiceHistory.push(voice);
        if (s.voiceHistory.length > 20) s.voiceHistory.shift();
      }
      sendCalib(s);
      showWordInfo(s.prosody);
      showVoice(s);
    },
    onFinal: (line, info, tone) => {
      if (latest !== s) return;
      showDelayInfo(s);
      const teach = PROMPTS[promptIdx]?.teach;
      const book = s.prosody.tones;
      if (teach && book.teach(teach, tone)) {
        const who = 'your';
        if (teach === 'neutral') setStatus(`Learned ${who} normal voice`, 'ok');
        else if (book.isUsable(teach)) setStatus(`Learned ${who} ${teach} voice ✓ (moods it can hear now: ${book.usable.join(', ')})`, 'ok');
        else setStatus(`That ${teach} sounded too close to ${who} normal voice. Exaggerate it and say it again.`, 'warn');
      }
      showLineInfo(line.text, line.emotion, line.confidence, info);
      logLine(line);
    },
  });
  session = latest = s;

  warmUp().then(() => { emotionReady = true; }).catch((err) => {
    console.error(err);
    setStatus('Emotion model failed to load; lines stay white', 'warn');
  });
  // Voiceprints only filter in "Main speaker only" mode: don't load (or warn about) the model otherwise.
  if (s.prosody.focus) {
    loadVoiceModel().then(() => {
      voiceReady = true;
      if (session === s) { s.voiceprints.refresh(s.prosody); showVoice(s); }
    }).catch((err) => {
      console.error(err);
      setStatus('Voiceprint model failed to load (run npm run setup); filtering by loudness and pitch only', 'warn');
    });
  }

  try {
    await openStt(s);
    if (session !== s) return;
    s.audio = await startAudio({
      source: ui.source.value,
      onEnded: () => { if (session === s) { setStatus('Tab sharing stopped', 'warn'); stop(); } },
      onFrame: (t, db, voicing, pitch) => s.prosody.push(t, db, voicing, pitch),
      onChunk: (buf, t, raw, rawEnd) => {
        s.voiceprints.ring.push(new Int16Array(raw), rawEnd);
        if (s.stt?.sendChunk(buf) && s.transcript.t0 == null) s.transcript.t0 = t - 0.1; // t = end of this 100 ms chunk
      },
    });
  } catch (err) {
    console.error(err);
    if (session !== s) return; // already ended; don't stop a newer session
    setStatus(err.message || String(err), 'err');
    stop();
    return;
  }
  // Scribe can close while the mic permission prompt is open; stop() then ran
  // before the mic existed, so release it here or it stays on.
  if (session !== s) { s.audio.stop(); return; }
  // Read now: Chrome returns no settings for a stopped track.
  s.mic = { label: s.audio.track?.label, ...s.audio.track?.getSettings() };
  showMic(s.mic);
  sendCalib(s);
  ui.stop.disabled = false;
  requestAnimationFrame(function meter() {
    if (session !== s) { ui.meter.style.width = '0'; return; }
    ui.meter.style.width = `${Math.round(s.prosody.liveLevel() * 100)}%`;
    // Keep the background gate at the main speaker's level (it follows calibration and the room).
    const gate = s.prosody.gateDb();
    const unvoiced = s.prosody.gateUnvoicedDb();
    const moved = (a, b) => a !== b && !(Math.abs(a - b) <= 0.5);
    if (moved(gate, s.gateSent) || moved(unvoiced, s.gateUnvoicedSent)) {
      s.audio.setGate(gate, unvoiced);
      s.gateSent = gate;
      s.gateUnvoicedSent = unvoiced;
    }
    if (ui.director.open) showLive(s.prosody);
    requestAnimationFrame(meter);
  });
}

const STT_RETRIES = 3;
const STT_FATAL = /auth|quota|unaccepted|terms/i; // errors a reconnect can't fix

async function openStt(s) {
  const stt = await openScribe({ modelId: config.STT_MODEL_ID, zeroRetention: config.STT_ZERO_RETENTION, vadSilenceSecs: config.VAD_SILENCE_SECS }, {
    onOpen: () => { s.retries = 0; setStatus('Listening', 'ok'); },
    onPartial: (text) => s.transcript.partial(text),
    onCommitted: (text) => s.transcript.committed(text),
    onCommittedTimed: (d) => s.transcript.committedTimed(d),
    onWarning: (msg) => setStatus(`Listening (ElevenLabs: ${msg})`, 'warn'),
    onError: (msg) => { s.lastError = msg; setStatus(msg, 'err'); },
    onClose: (reason) => sttClosed(s, s.lastError || reason),
  });
  if (session !== s) { stt.close(); return; } // stopped while connecting
  s.stt = stt;
}

// A dropped connection (network blip, Scribe's session limit) reconnects
// within the same session, so the judge's calibration and the log survive.
function sttClosed(s, reason) {
  if (session !== s) return;
  if (s.retries >= STT_RETRIES || STT_FATAL.test(reason)) {
    setStatus(`Speech-to-text closed: ${reason}`, 'err');
    stop();
    return;
  }
  s.retries++;
  s.lastError = null;
  s.transcript.resync();
  setStatus(`Speech-to-text dropped (${reason}). Reconnecting ${s.retries}/${STT_RETRIES}…`, 'warn');
  setTimeout(() => {
    if (session === s) openStt(s).catch((err) => sttClosed(s, err.message || String(err)));
  }, 1000 * s.retries);
}

function stop() {
  const s = session;
  session = null;
  if (s) {
    s.transcript.close();
    s.stt?.close();
    s.audio?.stop();
  }
  lastRecording = relay.recording.slice();
  ui.start.disabled = false;
  ui.focus.disabled = false;
  ui.source.disabled = false;
  ui.stop.disabled = true;
  if (!ui.status.classList.contains('err')) setStatus('Stopped');
}

function sendCalib(s) {
  if (session !== s) return;
  const progress = s.prosody.calibration;
  relay.send({ type: 'calib', progress });
  ui.calib.textContent = progress >= 1 ? 'Calibrated to your voice' : `Learning your voice… ${Math.round(progress * 100)}%`;
}

// ---------- line log ----------
function logLine(line) {
  const row = document.createElement('div');
  row.className = `row ${line.emotion}`;
  row.dataset.line = line.line;
  row.textContent = `[${line.emotion} ${line.confidence.toFixed(2)}] ` +
    line.words.map((w) => (w.level === 'normal' ? w.word : `${w.word}(${w.level}${w.wdth > 100 ? ',w' + w.wdth : ''})`)).join(' ');
  const old = ui.log.querySelector(`[data-line="${line.line}"]`); // a late timestamped commit re-finalizes a line
  if (old) old.replaceWith(row);
  else ui.log.prepend(row);
}

// ---------- replay ----------
function play(events) {
  stopReplay?.();
  relay.send({ type: 'clear' }, { record: false });
  setStatus('Replaying…', 'ok');
  stopReplay = relay.play(events, () => { stopReplay = null; setStatus('Replay finished'); });
}

ui.playDemo.onclick = async () => {
  try {
    const data = await (await fetch('/replay/demo.json')).json();
    play(data.events);
  } catch { setStatus('No replay/demo.json found', 'err'); }
};
ui.playLast.onclick = () => {
  if (!lastRecording?.length) return setStatus('Nothing recorded yet. Start, talk, then Stop.', 'warn');
  play(lastRecording);
};
ui.saveReplay.onclick = () => {
  if (!lastRecording?.length) return setStatus('Nothing recorded yet. Start, talk, then Stop.', 'warn');
  download('demo.json', JSON.stringify({ events: lastRecording }), 'application/json');
  setStatus('Saved. Move demo.json into the replay/ folder to use it offline.', 'ok');
};

// ---------- export ----------
function requireLines() {
  if (latest?.transcript.lines.length) return true;
  setStatus('No timed lines to export yet.', 'warn');
  return false;
}
ui.srt.onclick = () => { if (requireLines()) download('loudtype.srt', toSrt(latest.transcript.lines)); };
ui.ae.onclick = () => { if (requireLines()) download('loudtype.jsx', toAfterEffects(latest.transcript.lines)); };

// ---------- Director's View (control panel only, never on stream) ----------
const DV_RANGE = 20; // live bar shows normal ± 20 dB
const dvPos = (d) => `${Math.max(0, Math.min(100, 50 + (d / DV_RANGE) * 50))}%`;
function showTicks() {
  const k = Number(ui.sensitivity.value);
  ui.dvTicks.innerHTML = Object.entries(THRESHOLDS).map(([name, d0]) => {
    const d = Math.round((d0 / k) * 10) / 10;
    return `<span class="tick" style="left:${dvPos(d)}">${name}<br>${d > 0 ? '+' : ''}${d} dB</span>`;
  }).join('') + `<span class="tick mid" style="left:50%">normal</span>`;
}
showTicks();

function showLive(p) {
  const d = p.liveDelta();
  ui.dvLive.style.left = d == null ? '50%' : dvPos(d);
  ui.dvLive.style.opacity = d == null ? 0.25 : 1;
  ui.dvRef.textContent = p.calibrated
    ? `Speaker: normal ${p.ref.toFixed(1)} dBFS${p.pitch ? `, pitch ${Math.round(p.pitch)} Hz` : ''} (learned from their voice)`
    : `Learning the speaker's voice… ${Math.round(p.calibration * 100)}%`;
  const gate = p.gateDb();
  const snr = p.calibrated ? p.ref - p.noiseDb : null;
  ui.dvRoom.textContent = `Room noise: ${p.noiseDb.toFixed(1)} dBFS · ` + (gate === -Infinity
    ? 'background filter off: speech-to-text hears everything'
    : `speech-to-text only hears voices over ${gate.toFixed(1)} dBFS (whispers over ${p.gateUnvoicedDb().toFixed(1)})`)
    + (snr != null && snr < LOW_SNR_DB ? ` · voice only ${snr.toFixed(0)} dB over the room (built-in mic?): the voiceprint does the filtering; a headset is better` : '');
}
const LOW_SNR_DB = 20;
const thresholdsOf = (s, v) => {
  const t = STRICTNESS[s.voiceprints.strictness];
  return v.seconds >= VOICE.LONG_SEC ? t : { MATCH: t.MATCH_SHORT, OTHER: t.OTHER_SHORT };
};

// Voiceprint status: how many voices are enrolled and the last line's verdict.
function showVoice(s) {
  const p = s.prosody;
  if (!p.focus) { ui.dvVoice.textContent = 'Voiceprint: off (everyone is captioned; tick "Main speaker only" to filter)'; return; }
  if (!voiceReady) { ui.dvVoice.textContent = 'Voiceprint: loading model…'; return; }
  const n = s.voiceprints.count(p);
  const v = s.voice;
  ui.dvVoice.textContent = `Voiceprint: ${n ? 'enrolled' : 'not enrolled yet'}` + (!v ? '' : v.reason
    ? ` · last line: unsure (${v.reason})`
    : ` · last line: ${v.verdict === 'match' ? 'you ✓' : v.verdict === 'other' ? 'someone else ✗' : 'unsure (kept)'} (${v.score.toFixed(2)}; ${s.voiceprints.strictness}: dropped under ${thresholdsOf(s, v).OTHER})`);
}
// Auto gain or noise suppression would flatten the loudness Loudtype measures;
// audio.js asks Chrome to turn them off, and this shows whether it did.
function showMic(mic) {
  const on = (k) => (mic[k] == null ? 'unknown' : mic[k] ? 'ON (flattens loudness!)' : 'off');
  ui.dvMic.textContent = `Mic: ${mic.label || 'unnamed'} · auto gain ${on('autoGainControl')} · noise suppression ${on('noiseSuppression')}`;
}
function showWordInfo(p) {
  const w = p.last;
  if (!w) return;
  if (w.silent) { ui.dvWord.textContent = `Last word "${w.word}": no voice found where it was timed (left normal)`; return; }
  if (w.background) { ui.dvWord.textContent = `Last word "${w.word}": ignored, ${w.background}`; return; }
  ui.dvWord.textContent = `Last word "${w.word}": ${w.level}` +
    (w.delta != null ? ` · ${w.delta >= 0 ? '+' : ''}${w.delta.toFixed(1)} dB vs normal` : '') +
    ` · voiced ${(w.voiced * 100).toFixed(0)}%${w.voiced < 0.3 ? ' (whisper-like)' : ''}`;
}
function showLineInfo(text, emotion, confidence, info) {
  ui.dvLine.textContent = `Last line: ${emotion}` + (forcedMood ? ' (forced by hotkey)' :
    info ? ` · confidence ${confidence.toFixed(2)} (needs ${config.EMOTION_MIN_CONFIDENCE}) · voice+text energy ${info.energy.toFixed(2)} · model: ${info.top}` : '');
}

// Everything needed to tune levels for a real mic, as JSON on the clipboard.
function micReport(s) {
  const p = s.prosody;
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const mic = s.mic ?? {};
  const spread = (dbs) => {
    const sorted = [...dbs].sort((a, b) => a - b);
    const at = (q) => r1(sorted[Math.floor((sorted.length - 1) * q)]);
    return sorted.length ? { min: at(0), p10: at(0.1), p50: at(0.5), p90: at(0.9), max: at(1) } : null;
  };
  return {
    mic: mic.label ?? null,
    chromeApplied: { autoGainControl: mic.autoGainControl, noiseSuppression: mic.noiseSuppression, echoCancellation: mic.echoCancellation, sampleRate: mic.sampleRate },
    calibrated: p.calibrated, normalDb: r1(p.ref), pitchHz: p.pitch && Math.round(p.pitch), noiseFloorDb: r1(p.noiseDb), thresholds: p.thresholds(),
    ignoreBackground: p.focus, gateDb: r1(Number.isFinite(p.gateDb()) ? p.gateDb() : null),
    gateUnvoicedDb: r1(Number.isFinite(p.gateUnvoicedDb()) ? p.gateUnvoicedDb() : null),
    sensitivity: p.sensitivity,
    voiceprints: { modelReady: voiceReady, strictness: s.voiceprints.strictness, enrolled: s.voiceprints.count(p),
      recentLines: s.voiceHistory.map((v) => ({ verdict: v.verdict, score: Math.round(v.score * 100) / 100, seconds: r1(v.seconds), reason: v.reason })),
      lastLine: s.voice && { verdict: s.voice.verdict, score: Math.round(s.voice.score * 100) / 100, scores: s.voice.scores.map((x) => (x == null ? null : Math.round(x * 100) / 100)), seconds: r1(s.voice.seconds), reason: s.voice.reason } },
    // What speech-to-text committed vs. what reached the overlay, per line (empty "shown" = dropped by Loudtype).
    heardVsShown: latest?.transcript.heard ?? [],
    allFramesDbLast30s: spread(p.frames.map((f) => f.db)), // the quiet end is the real room noise
    speechDbLast30s: spread(p.frames.filter((f) => f.speech).map((f) => f.db)),
    words: p.history.map((w) => ({ word: w.word, level: w.level, db: r1(w.db), vsNormal: r1(w.delta), voicedPct: Math.round(w.voiced * 100), pitchHz: w.pitch || null, speech: w.speech, silent: w.silent, ignored: w.background ?? null })),
  };
}
// One committed line's audio (pre-gate, from memory) through /transcribe → batch Scribe v2.
// It hears up to SOUND_PAD_SEC around the words, for laughter just before or after them,
// but never audio an earlier line already sent (no tag twice; transcript.js keeps only this line's words).
const SOUND_PAD_SEC = 1.5;
async function refineLine(s, start, end) {
  const ring = s.voiceprints.ring;
  // Never cut into this line's own words, even if the previous line's padding reached them;
  // never before the first sample heard.
  const before = Math.min(start - 0.25, Math.max(start - SOUND_PAD_SEC, s.refinedUntil ?? -Infinity));
  const offset = Math.max(before, ring.endT - ring.total / ring.rate);
  end = Math.min(end + SOUND_PAD_SEC, ring.endT);
  s.refinedUntil = end;
  const audio = ring.slice(offset, end);
  if (!audio || audio.length < 16000 * 0.3) return null;
  const r = await fetch('/transcribe', { method: 'POST', body: audio.slice().buffer });
  if (!r.ok) throw new Error(`Second-pass transcript failed: ${(await r.json().catch(() => ({}))).error || r.status}`);
  return { ...(await r.json()), offset };
}

// The last 60 s the app heard (16 kHz mono WAV), saved only on click: real audio to tune emotion on.
ui.dvAudio.onclick = () => {
  const s = session ?? latest;
  const ring = s?.voiceprints.ring;
  const audio = ring?.endT != null ? ring.slice(ring.endT - 60, ring.endT) : null;
  if (!audio?.length) return setStatus('Start listening first, then save the audio.', 'warn');
  const data = new DataView(new ArrayBuffer(44 + audio.length * 2));
  const str = (o, t) => [...t].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); data.setUint32(4, 36 + audio.length * 2, true); str(8, 'WAVEfmt '); data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, 16000, true); data.setUint32(28, 32000, true);
  data.setUint16(32, 2, true); data.setUint16(34, 16, true); str(36, 'data'); data.setUint32(40, audio.length * 2, true);
  audio.forEach((v, i) => data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  download('loudtype-last-60s.wav', data.buffer, 'audio/wav');
  setStatus(`Saved ${Math.round(audio.length / 16000)} s of audio to your Downloads.`, 'ok');
};

ui.dvCopy.onclick = async () => {
  const s = session ?? latest;
  if (!s) return setStatus('Start listening first, then copy the mic report.', 'warn');
  const text = JSON.stringify(micReport(s), null, 1);
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Mic report copied (${s.prosody.history.length} words).`, 'ok');
  } catch {
    console.log(text);
    setStatus('Could not copy; the mic report is in the browser console.', 'warn');
  }
};

// ---------- creator controls ----------
// Hotkeys force a mood (e.g. a fake rage bit goes red on cue); 0 = automatic.
const MOOD_KEYS = { 1: 'happy', 2: 'calm', 3: 'angry', 4: 'sad', 5: 'surprised', 6: 'scared', 7: 'disgusted', 0: null };
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return; // Cmd+1 switches tabs, it isn't a mood
  if (e.target.closest('input, select, textarea') || !(e.key in MOOD_KEYS)) return;
  forcedMood = MOOD_KEYS[e.key];
  ui.mood.textContent = forcedMood ? `Mood forced: ${forcedMood} (press 0 for automatic)` : 'Mood: automatic';
  session?.transcript.refresh();
});

// Judge prompt cards, shown on the overlay during the table demo. Cards with
// `teach` record how the judge's voice sounds in that mood (tone.js ToneBook):
// afterwards their voice alone can color a line, even with neutral words.
const SAME = '“The next round starts in two minutes.”';
const PROMPTS = [
  { text: 'Say hi normally: “Hi, I\'m one of the judges at Hacklanta today.”', teach: 'neutral' },
  { text: `Teach it HAPPY: say ${SAME} like it's amazing news`, teach: 'happy' },
  { text: `Teach it ANGRY: say ${SAME} like you're furious`, teach: 'angry' },
  { text: `Teach it SAD: say ${SAME} like it's heartbreaking`, teach: 'sad' },
  { text: 'Now pick a mood and say: “The meeting is at three on Tuesday.” Watch the color.' },
  { text: 'Now whisper: “this is the best day ever”' },
  { text: 'Now SHOUT it: “THIS IS THE BEST DAY EVER!”' },
  { text: 'Hold a word as long as you can: “nooooooo”' },
  { text: 'Free play: talk like a streamer.' },
];
let promptIdx = -1;
const teachingMood = () => { const t = PROMPTS[promptIdx]?.teach; return t && t !== 'neutral' ? t : null; };
function showPrompt(i) {
  promptIdx = Math.max(-1, Math.min(PROMPTS.length - 1, i));
  const text = promptIdx >= 0 ? PROMPTS[promptIdx].text : '';
  ui.prompt.textContent = text ? `${promptIdx + 1}/${PROMPTS.length}: ${text}` : '(hidden)';
  relay.send({ type: 'prompt', text, step: promptIdx + 1, of: PROMPTS.length }, { record: false });
}
ui.promptNext.onclick = () => showPrompt(promptIdx + 1);
ui.promptPrev.onclick = () => showPrompt(promptIdx - 1);
ui.promptHide.onclick = () => showPrompt(-1);

// New judge: forget the last voice, clear the screen, start the prompt cards.
ui.newJudge.onclick = () => {
  if (session) {
    session.prosody.recalibrate();
    session.sync.clear();
    session.transcript.resetCaption();
    session.voice = null; // the voiceprint is relearned from the new calibration
    showVoice(session);
    sendCalib(session);
  }
  relay.send({ type: 'clear' }, { record: false });
  showPrompt(0);
};

// ---------- sync mode ----------
function streamDelay() { return Math.max(0, Math.min(30, Number(ui.delay.value) || 0)); }
ui.delay.value = String(store.get('loudtype.delay') ?? config.STREAM_DELAY_SECS ?? 0);
ui.delay.onchange = () => {
  ui.delay.value = String(streamDelay());
  store.set('loudtype.delay', ui.delay.value);
  if (latest?.sync) latest.sync.delay = streamDelay();
  showDelayInfo(latest);
};
/** How soon captions are finished vs. the delay set: tells the streamer the delay to use. */
function showDelayInfo(s) {
  const r = s?.sync?.readiness();
  const d = streamDelay();
  if (!r) { ui.delayInfo.textContent = d ? `Sync on: captions show ${d} s after speech.` : ''; return; }
  const ready = `Captions are finished ~${r.typical.toFixed(1)} s after a line starts (slow lines ${r.slow.toFixed(1)} s)`;
  ui.delayInfo.textContent = !d ? `${ready}. For sync, set a stream delay of at least ${r.suggest} s.`
    : d >= r.slow ? `${ready}. Delay ${d} s: every word lands on time ✓`
    : `${ready}. Delay ${d} s is short: some words will be late (use ${r.suggest} s or more).`;
}

// ---------- controls ----------
ui.strictness.onchange = () => { if (session) { session.voiceprints.strictness = ui.strictness.value; showVoice(session); } };
ui.sensitivity.oninput = () => {
  ui.sensitivityValue.textContent = Number(ui.sensitivity.value).toFixed(1);
  if (session) session.prosody.sensitivity = Number(ui.sensitivity.value);
  showTicks();
};
ui.start.onclick = start;
ui.stop.onclick = stop;
ui.pack.onchange = () => relay.send({ type: 'pack', pack: ui.pack.value }, { record: false });

// Look: subtitle font and reduce motion. Remembered in this browser (a convenience only);
// sent to overlays when they change, when the relay connects, and when an overlay (re)loads.
for (const [id, name] of Object.entries(FONTS)) ui.font.add(new Option(name, id));
function sendLook() {
  relay.send({ type: 'font', font: /** @type {import('./caption.js').FontId} */ (ui.font.value) }, { record: false });
  relay.send({ type: 'motion', reduce: ui.reduceMotion.checked }, { record: false });
}
function applyLookDefaults() {
  ui.font.value = store.get('loudtype.font') ?? (config.CAPTION_FONT in FONTS ? config.CAPTION_FONT : 'flex');
  const saved = store.get('loudtype.reduceMotion');
  ui.reduceMotion.checked = saved != null ? saved === '1' : !!config.REDUCE_MOTION;
}
applyLookDefaults();
ui.font.onchange = () => { store.set('loudtype.font', ui.font.value); sendLook(); };
ui.reduceMotion.onchange = () => { store.set('loudtype.reduceMotion', ui.reduceMotion.checked ? '1' : '0'); sendLook(); };
relay.onOpen = sendLook;
relay.onMessage = (msg) => { if (msg?.type === 'hello') sendLook(); };

// Debugging from the console: loudtype.session().prosody, etc.
window.loudtype = { session: () => session, micReport: () => latest && micReport(latest) };
