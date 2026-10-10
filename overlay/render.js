// Overlay: draws what the control panel sends. Holds no state worth saving,
// so OBS can reload it at any time.
const ICONS = { happy: '★', calm: '●', angry: '▲', sad: '▼', neutral: '' };
const CLEAR_AFTER_MS = 3500;
const MAX_LINES = 2;

const stage = document.getElementById('stage');
const calib = document.getElementById('calib');
const calibFill = calib.querySelector('.fill');
const params = new URLSearchParams(location.search);
if (params.has('bg')) document.body.classList.add('debug-bg');

let settings = { SHOUT_POP: true, COLORBLIND_PALETTE: false };
fetch('/config').then((r) => r.json()).then((c) => {
  settings = { ...settings, ...c };
  document.body.classList.toggle('colorblind', !!settings.COLORBLIND_PALETTE);
}).catch(() => {});

const lines = new Map(); // line id → { el, icon, words: [span] }
let clearTimer = null;

function getLine(id) {
  let l = lines.get(id);
  if (l) return l;
  const el = document.createElement('div');
  el.className = 'line';
  const icon = document.createElement('span');
  icon.className = 'icon';
  el.appendChild(icon);
  stage.appendChild(el);
  l = { el, icon, words: [] };
  lines.set(id, l);
  // Keep only the newest lines on screen.
  while (lines.size > MAX_LINES) {
    const [oldId, old] = lines.entries().next().value;
    old.el.remove();
    lines.delete(oldId);
  }
  return l;
}

// Long utterances are shown as short caption chunks (like TV captions) so
// words keep arriving on a fresh line instead of scrolling one long one.
const CHUNK_WORDS = 7;
const CHUNK_MIN_AT_SENTENCE = 3; // break after . ? ! once a chunk has this many words
const STAGGER_MS = 90;           // words that arrive together fade in one by one
const STAGGER_MAX_MS = 450;

function chunk(words) {
  const pages = [];
  let start = 0;
  words.forEach((w, i) => {
    const len = i - start + 1;
    if (len >= CHUNK_WORDS || (len >= CHUNK_MIN_AT_SENTENCE && /[.?!]["')\]]*$/.test(w.word) && i < words.length - 1)) {
      pages.push([start, i + 1]);
      start = i + 1;
    }
  });
  if (start < words.length) pages.push([start, words.length]);
  return pages;
}

function renderLine(msg) {
  const pages = chunk(msg.words);
  // Revisions can shorten an utterance: drop chunks that no longer exist.
  for (const [key, l] of lines) {
    const [lineId, page] = key.split(':').map(Number);
    if (lineId === msg.line && page >= pages.length) { l.el.remove(); lines.delete(key); }
  }
  pages.slice(-MAX_LINES).forEach(([a, b]) => {
    const page = pages.findIndex((p) => p[0] === a);
    renderChunk(`${msg.line}:${page}`, msg.words.slice(a, b), msg);
  });
}

function renderChunk(key, words, msg) {
  const l = getLine(key);
  l.el.classList.remove('fading');

  let fresh = 0;
  words.forEach((w, i) => {
    let span = l.words[i];
    const isNew = !span;
    if (isNew) {
      span = document.createElement('span');
      span.className = 'w';
      span.style.animationDelay = `${Math.min(fresh++ * STAGGER_MS, STAGGER_MAX_MS)}ms`;
      l.el.appendChild(span);
      l.words.push(span);
    }
    const prevLevel = span.dataset.level;
    span.dataset.level = w.level;
    span.textContent = w.word;
    span.style.setProperty('--size', w.size);
    span.style.setProperty('--wght', w.wght);
    span.style.setProperty('--wdth', w.wdth);
    span.style.setProperty('--op', w.level === 'whisper' ? 0.85 : 1);
    const shout = w.level === 'shout' && settings.SHOUT_POP;
    if (isNew) span.classList.add(shout ? 'pop' : 'enter');
    else if (shout && prevLevel !== 'shout') {
      span.style.animationDelay = '0ms';
      span.classList.remove('enter', 'pop');
      void span.offsetWidth; // restart animation
      span.classList.add('pop');
    }
  });
  // Partial transcripts can shrink when the recognizer revises itself.
  while (l.words.length > words.length) l.words.pop().remove();

  const emotion = msg.emotion || 'neutral';
  l.el.classList.remove('happy', 'calm', 'angry', 'sad', 'provisional');
  if (emotion !== 'neutral') l.el.classList.add(emotion);
  if (msg.provisional) l.el.classList.add('provisional');
  l.icon.textContent = ICONS[emotion] || '';

  fitLine(l);
}

// A line never wraps. If it's too wide, shrink the whole line evenly (keeps
// every word and the size contrast between them); only if it would get too
// small, hide its oldest words. Layout widths ignore the shout pop transform.
const MIN_FIT = 0.65;
function fitLine(l) {
  l.words.forEach((s) => s.classList.remove('hidden'));
  l.el.style.setProperty('--fit', 1);
  const max = stage.clientWidth;
  const width = () => [l.icon, ...l.words].reduce((a, e) => a + e.offsetWidth, 0);
  const fit = Math.max(MIN_FIT, Math.min(1, max / width()));
  l.el.style.setProperty('--fit', fit.toFixed(3));
  for (const s of l.words.slice(0, -1)) { // always keep the newest word
    if (width() <= max) break;
    s.classList.add('hidden');
  }
}

function scheduleClear() {
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    for (const [id, l] of lines) {
      l.el.classList.add('fading');
      // Check it's still this line: after a clear, a new line can reuse the id.
      setTimeout(() => { if (lines.get(id) === l && l.el.classList.contains('fading')) { l.el.remove(); lines.delete(id); } }, 450);
    }
  }, CLEAR_AFTER_MS);
}

function clearAll() {
  for (const l of lines.values()) l.el.remove();
  lines.clear();
}

function handle(msg) {
  switch (msg.type) {
    case 'line': renderLine(msg); scheduleClear(); break;
    case 'calib':
      calib.hidden = msg.progress >= 1 || msg.progress < 0;
      calibFill.style.width = `${Math.round(Math.max(0, msg.progress) * 100)}%`;
      break;
    case 'pack':
      document.body.className = document.body.className.replace(/pack-\S+/g, '').trim();
      document.body.classList.add(`pack-${msg.pack}`);
      break;
    case 'clear': clearAll(); break;
    case 'prompt': {
      const card = document.getElementById('prompt');
      card.hidden = !msg.text;
      card.querySelector('.step').textContent = msg.text ? `Try this · ${msg.step} of ${msg.of}` : '';
      card.querySelector('.text').textContent = msg.text || '';
      break;
    }
  }
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/relay`);
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();
window.loudtype = { handle }; // for debugging from the console
