// Control panel: listens, analyzes, and tells the overlay what to draw.
import { startAudio } from './audio.js';
import { openScribe } from './stt.js';
import { Prosody, THRESHOLDS } from './prosody.js';
import { Transcript } from './transcript.js';
import { classify, warmUp } from './emotion.js';
import { Relay } from './relay.js';
import { download, toSrt, toAfterEffects } from './export.js';

const $ = (id) => document.getElementById(id);
const ui = {
  start: $('start'), stop: $('stop'), status: $('status'), meter: $('meter-fill'),
  pack: $('pack'), saveReplay: $('save-replay'), playDemo: $('play-demo'), playLast: $('play-last'),
  srt: $('export-srt'), ae: $('export-ae'), log: $('log'), calib: $('calib'),
  newJudge: $('new-judge'), mood: $('mood'), prompt: $('prompt'), promptPrev: $('prompt-prev'),
  promptNext: $('prompt-next'), promptHide: $('prompt-hide'), director: $('director'),
  dvLive: $('dv-live'), dvRef: $('dv-ref'), dvWord: $('dv-word'), dvLine: $('dv-line'), dvTicks: $('dv-ticks'),
  dvMic: $('dv-mic'), dvRoom: $('dv-room'), dvCopy: $('dv-copy'), focus: $('focus'),
};

let config = { EMOTION_MIN_CONFIDENCE: 0.7, STT_ZERO_RETENTION: true, STT_MODEL_ID: 'scribe_v2_realtime' };
const relay = new Relay();
let session = null; // the running session
let latest = null;  // the newest session, running or stopped: what Export and the log show
let lastRecording = null;
let stopReplay = null;
let emotionReady = false;
let forcedMood = null; // creator override from hotkeys; null = automatic

fetch('/config').then((r) => r.json()).then((c) => {
  config = { ...config, ...c };
  ui.focus.checked = config.IGNORE_BACKGROUND !== false;
  if (session) session.prosody.focus = ui.focus.checked;
}).catch(() => {});

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = kind;
}

// ---------- session ----------
async function start() {
  ui.start.disabled = true;
  setStatus('Starting…');
  stopReplay?.();
  relay.resetRecording();
  relay.send({ type: 'clear' });
  ui.log.textContent = '';

  const s = { prosody: new Prosody(), transcript: null, audio: null, stt: null, retries: 0, lastError: null, mic: null, gateSent: null };
  s.prosody.focus = ui.focus.checked;
  s.transcript = new Transcript({
    prosody: s.prosody,
    // A line from an older session can still be classifying after Start; it
    // must not reach the new session's overlay, log or recording.
    send: (msg) => { if (latest === s) relay.send(msg); },
    classify: (text, levels) => (emotionReady ? classify(text, levels, config.EMOTION_MIN_CONFIDENCE) : null),
    mood: () => forcedMood,
    onStyled: () => { sendCalib(s); showWordInfo(s.prosody); },
    onFinal: (line, info) => {
      if (latest !== s) return;
      showLineInfo(line.text, line.emotion, line.confidence, info);
      logLine(line);
    },
  });
  session = latest = s;

  warmUp().then(() => { emotionReady = true; }).catch((err) => {
    console.error(err);
    setStatus('Emotion model failed to load; lines stay white', 'warn');
  });

  try {
    await openStt(s);
    if (session !== s) return;
    s.audio = await startAudio({
      onFrame: (t, db, voicing, pitch) => s.prosody.push(t, db, voicing, pitch),
      onChunk: (buf, t) => {
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
    if (gate !== s.gateSent && !(Math.abs(gate - s.gateSent) <= 0.5)) { s.audio.setGate(gate); s.gateSent = gate; }
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
  ui.stop.disabled = true;
  if (!ui.status.classList.contains('err')) setStatus('Stopped');
}

function sendCalib(s) {
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
ui.dvTicks.innerHTML = Object.entries(THRESHOLDS)
  .map(([name, d]) => `<span class="tick" style="left:${dvPos(d)}">${name}<br>${d > 0 ? '+' : ''}${d} dB</span>`).join('')
  + `<span class="tick mid" style="left:50%">normal</span>`;

function showLive(p) {
  const d = p.liveDelta();
  ui.dvLive.style.left = d == null ? '50%' : dvPos(d);
  ui.dvLive.style.opacity = d == null ? 0.25 : 1;
  ui.dvRef.textContent = p.calibrated
    ? `Main speaker: normal ${p.ref.toFixed(1)} dBFS${p.pitch ? `, pitch ${Math.round(p.pitch)} Hz` : ''} (learned from their voice)`
    : `Learning the main speaker's voice… ${Math.round(p.calibration * 100)}%`;
  const gate = p.gateDb();
  ui.dvRoom.textContent = `Room noise: ${p.noiseDb.toFixed(1)} dBFS · ` + (gate === -Infinity
    ? 'background filter off: speech-to-text hears everything'
    : `speech-to-text only hears audio over ${gate.toFixed(1)} dBFS`);
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
    calibrated: p.calibrated, normalDb: r1(p.ref), pitchHz: p.pitch && Math.round(p.pitch), noiseFloorDb: r1(p.noiseDb), thresholds: THRESHOLDS,
    ignoreBackground: p.focus, gateDb: r1(Number.isFinite(p.gateDb()) ? p.gateDb() : null),
    allFramesDbLast30s: spread(p.frames.map((f) => f.db)), // the quiet end is the real room noise
    speechDbLast30s: spread(p.frames.filter((f) => f.speech).map((f) => f.db)),
    words: p.history.map((w) => ({ word: w.word, level: w.level, db: r1(w.db), vsNormal: r1(w.delta), voicedPct: Math.round(w.voiced * 100), pitchHz: w.pitch || null, speech: w.speech, silent: w.silent, ignored: w.background ?? null })),
  };
}
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
const MOOD_KEYS = { 1: 'happy', 2: 'calm', 3: 'angry', 4: 'sad', 0: null };
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return; // Cmd+1 switches tabs, it isn't a mood
  if (e.target.closest('input, select, textarea') || !(e.key in MOOD_KEYS)) return;
  forcedMood = MOOD_KEYS[e.key];
  ui.mood.textContent = forcedMood ? `Mood forced: ${forcedMood} (press 0 for automatic)` : 'Mood: automatic';
  session?.transcript.refresh();
});

// Judge prompt cards, shown on the overlay during the table demo.
const PROMPTS = [
  'Say hi normally: “Hi, I\'m one of the judges at Hacklanta today.”',
  'Now whisper: “this is the best day ever”',
  'Now SHOUT it: “THIS IS THE BEST DAY EVER!”',
  'Hold a word as long as you can: “nooooooo”',
  'Complain about something (traffic, Mondays, a boss fight). Say it like you mean it.',
  'Free play: talk like a streamer.',
];
let promptIdx = -1;
function showPrompt(i) {
  promptIdx = Math.max(-1, Math.min(PROMPTS.length - 1, i));
  const text = promptIdx >= 0 ? PROMPTS[promptIdx] : '';
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
    sendCalib(session);
  }
  relay.send({ type: 'clear' }, { record: false });
  showPrompt(0);
};

// ---------- controls ----------
ui.focus.onchange = () => { if (session) session.prosody.focus = ui.focus.checked; };
ui.start.onclick = start;
ui.stop.onclick = stop;
ui.pack.onchange = () => relay.send({ type: 'pack', pack: ui.pack.value }, { record: false });

// Debugging from the console: loudtype.session().prosody, etc.
window.loudtype = { session: () => session, micReport: () => latest && micReport(latest) };
