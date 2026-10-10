// Control panel: listens, analyzes, and tells the overlay what to draw.
import { startAudio } from './audio.js';
import { openScribe } from './stt.js';
import { Prosody, LEVELS, THRESHOLDS } from './prosody.js';
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
};

let config = { EMOTION_MIN_CONFIDENCE: 0.7, STT_ZERO_RETENTION: true, STT_MODEL_ID: 'scribe_v2_realtime' };
const relay = new Relay();
let session = null;
const sessionLines = []; // finished lines with timings, for export only (memory)
let lastRecording = null;
let stopReplay = null;
let emotionReady = false;
let forcedMood = null; // creator override from hotkeys; null = automatic

fetch('/config').then((r) => r.json()).then((c) => { config = { ...config, ...c }; }).catch(() => {});

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
  sessionLines.length = 0;
  ui.log.textContent = '';

  const s = {
    prosody: new Prosody(),
    audio: null, stt: null,
    t0: null,             // AudioContext time of STT time 0
    lineSeq: 0,
    current: null,        // { id, text, provisional, classifying }
    pendingCommit: null,
    lastFinal: { text: '', at: 0 },
    lags: [],             // measured partial delays (s)
  };
  session = s;

  warmUp().then(() => { emotionReady = true; }).catch((err) => {
    console.error(err);
    setStatus('Emotion model failed to load; lines stay white', 'warn');
  });

  try {
    s.stt = await openScribe({ modelId: config.STT_MODEL_ID, zeroRetention: config.STT_ZERO_RETENTION, vadSilenceSecs: config.VAD_SILENCE_SECS }, {
      onOpen: () => setStatus('Listening', 'ok'),
      onPartial: (text) => onPartial(s, text),
      onCommitted: (text) => onCommitted(s, text),
      onCommittedTimed: (d) => onCommittedTimed(s, d),
      onWarning: (msg) => setStatus(`Listening (ElevenLabs: ${msg})`, 'warn'),
      onError: (msg) => { setStatus(msg, 'err'); },
      onClose: (reason) => { if (session === s) { setStatus(`Speech-to-text closed: ${reason}`, 'err'); stop(); } },
    });
    s.audio = await startAudio({
      onFrame: (t, db, voicing) => s.prosody.push(t, db, voicing),
      onChunk: (buf, t) => {
        if (s.stt.sendChunk(buf) && s.t0 == null) s.t0 = t - 0.1; // t = end of this 100 ms chunk
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
  sendCalib(s);
  ui.stop.disabled = false;
  requestAnimationFrame(function meter() {
    if (session !== s) { ui.meter.style.width = '0'; return; }
    ui.meter.style.width = `${Math.round(s.prosody.liveLevel() * 100)}%`;
    if (ui.director.open) showLive(s.prosody);
    requestAnimationFrame(meter);
  });
}

function stop() {
  const s = session;
  session = null;
  if (s) {
    clearTimeout(s.pendingCommit);
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

const splitWords = (text) => text.trim().split(/\s+/).filter(Boolean);
const plainWord = (word) => ({ word, level: 'normal', ...LEVELS.normal, wdth: 100 });
// Partials arrive ~1 s after the words were spoken. The real delay is learned
// from committed word timestamps (median of recent measurements).
const LAG_DEFAULT = 1.0;
const LIVE_MIN_WINDOW = 0.35; // s of audio used to style a newly appeared word
function partialLag(s) {
  if (s.lags.length < 3) return LAG_DEFAULT;
  const sorted = [...s.lags].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ---------- transcript handling ----------
function onPartial(s, text) {
  if (session !== s || !text.trim()) return;
  const now = s.prosody.frames.at(-1)?.t ?? 0; // latest audio actually measured
  if (!s.current) s.current = { id: ++s.lineSeq, text: '', styles: [], seenAt: [], lastAt: now - 0.8, provisional: 'neutral', classifying: false };
  const cur = s.current;
  cur.text = text;

  // Style new words immediately from the audio they most likely came from
  // (since the previous partial, minus recognizer lag), so a shout is big the
  // moment it appears instead of after the line commits.
  const words = splitWords(text);
  if (words.length > cur.styles.length) {
    const lag = partialLag(s);
    const end = now - lag;
    const start = Math.min(cur.lastAt - lag, end - LIVE_MIN_WINDOW);
    while (cur.seenAt.length < words.length) cur.seenAt.push(now);
    cur.styles.push(...s.prosody.styleLive(start, end, words.length - cur.styles.length));
  }
  cur.styles.length = words.length; // recognizer may drop words when revising
  cur.seenAt.length = words.length;
  cur.lastAt = now;
  emitPartial(cur);

  // Provisional tint after ~4 words, one classification at a time.
  if (emotionReady && !cur.classifying && words.length >= 4) {
    cur.classifying = true;
    classify(text, cur.styles.map((st) => st.level), config.EMOTION_MIN_CONFIDENCE)
      .then(({ emotion }) => {
        if (s.current !== cur) return;
        cur.provisional = emotion;
        emitPartial(cur);
      })
      .catch(() => {})
      .finally(() => { cur.classifying = false; });
  }
}

function emitPartial(cur) {
  relay.send({
    type: 'line', line: cur.id, final: false, provisional: true,
    emotion: forcedMood ?? cur.provisional, confidence: 0,
    words: splitWords(cur.text).map((word, i) => ({ word, ...(cur.styles[i] || plainWord(word)) })),
  });
}

// Scribe sends the plain commit and the timestamped one; prefer the timestamped.
function onCommitted(s, text) {
  if (session !== s) return;
  if (!text.trim()) { s.current = null; return; }
  if (text === s.lastFinal.text && performance.now() - s.lastFinal.at < 3000) return;
  clearTimeout(s.pendingCommit);
  s.pendingCommit = setTimeout(() => finalize(s, text, null), 600);
}

function onCommittedTimed(s, { text, words }) {
  if (session !== s) return;
  clearTimeout(s.pendingCommit);
  if (!text.trim() || !words.length) { s.current = null; return; }
  finalize(s, text, words);
}

async function finalize(s, text, timedWords) {
  const id = s.current?.id ?? ++s.lineSeq;
  const provisional = s.current?.provisional ?? 'neutral';
  // Learn the partial delay: when each word first showed up vs. when it ended.
  if (timedWords && s.t0 != null && s.current) {
    s.current.seenAt.slice(0, timedWords.length).forEach((seen, i) => {
      const lag = seen - (s.t0 + timedWords[i].end);
      if (lag > 0.05 && lag < 3) s.lags.push(lag);
    });
    s.lags.splice(0, Math.max(0, s.lags.length - 40));
  }
  s.current = null;
  s.lastFinal = { text, at: performance.now() };

  let words;
  s.debugWords = timedWords;
  if (timedWords && s.t0 != null) {
    words = timedWords.map((w) => ({
      word: w.text.trim(),
      ...s.prosody.styleWord(w.text, s.t0 + w.start, s.t0 + w.end),
      start: w.start, end: w.end,
    })).filter((w) => w.word);
  } else {
    words = splitWords(text).map(plainWord); // no timing: unstyled, not exportable
  }
  sendCalib(s);
  showWordInfo(s.prosody);

  const base = { type: 'line', line: id, words };
  relay.send({ ...base, final: false, provisional: true, emotion: forcedMood ?? provisional, confidence: 0 });

  let emotion = 'neutral', confidence = 0, info = null;
  if (emotionReady) {
    try {
      info = await classify(text, words.map((w) => w.level), config.EMOTION_MIN_CONFIDENCE);
      ({ emotion, confidence } = info);
    } catch (err) { console.error(err); }
  }
  if (forcedMood) { emotion = forcedMood; confidence = 1; }
  showLineInfo(text, emotion, confidence, info);
  relay.send({ ...base, final: true, provisional: false, emotion, confidence: +confidence.toFixed(2) });

  const line = { line: id, text, emotion, confidence, words };
  if (words.every((w) => typeof w.start === 'number')) sessionLines.push(line);
  logLine(line);
}

function logLine(line) {
  const row = document.createElement('div');
  row.className = `row ${line.emotion}`;
  row.textContent = `[${line.emotion} ${line.confidence.toFixed(2)}] ` +
    line.words.map((w) => (w.level === 'normal' ? w.word : `${w.word}(${w.level}${w.wdth > 100 ? ',w' + w.wdth : ''})`)).join(' ');
  ui.log.prepend(row);
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
  if (sessionLines.length) return true;
  setStatus('No timed lines to export yet.', 'warn');
  return false;
}
ui.srt.onclick = () => { if (requireLines()) download('loudtype.srt', toSrt(sessionLines)); };
ui.ae.onclick = () => { if (requireLines()) download('loudtype.jsx', toAfterEffects(sessionLines)); };

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
    ? `Your normal level: ${p.ref.toFixed(1)} dBFS (learned from your voice)`
    : `Learning your normal level… ${Math.round(p.calibration * 100)}%`;
}
function showWordInfo(p) {
  const w = p.last;
  if (!w) return;
  ui.dvWord.textContent = `Last word "${w.word}": ${w.level}` +
    (w.delta != null ? ` · ${w.delta >= 0 ? '+' : ''}${w.delta.toFixed(1)} dB vs normal` : '') +
    ` · voiced ${(w.voiced * 100).toFixed(0)}%${w.voiced < 0.3 ? ' (whisper-like)' : ''}`;
}
function showLineInfo(text, emotion, confidence, info) {
  ui.dvLine.textContent = `Last line: ${emotion}` + (forcedMood ? ' (forced by hotkey)' :
    info ? ` · confidence ${confidence.toFixed(2)} (needs ${config.EMOTION_MIN_CONFIDENCE}) · voice+text energy ${info.energy.toFixed(2)} · model: ${info.top}` : '');
}

// ---------- creator controls ----------
// Hotkeys force a mood (e.g. a fake rage bit goes red on cue); 0 = automatic.
const MOOD_KEYS = { 1: 'happy', 2: 'calm', 3: 'angry', 4: 'sad', 0: null };
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return; // Cmd+1 switches tabs, it isn't a mood
  if (e.target.closest('input, select, textarea') || !(e.key in MOOD_KEYS)) return;
  forcedMood = MOOD_KEYS[e.key];
  ui.mood.textContent = forcedMood ? `Mood forced: ${forcedMood} (press 0 for automatic)` : 'Mood: automatic';
  if (session?.current) emitPartial(session.current);
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
ui.start.onclick = start;
ui.stop.onclick = stop;
ui.pack.onchange = () => relay.send({ type: 'pack', pack: ui.pack.value }, { record: false });

// Debugging from the console: loudtype.session().prosody, etc.
window.loudtype = { session: () => session };
