// Overlay: draws what the control panel sends. Holds no state worth saving,
// so OBS can reload it at any time.
import { ICONS, FONTS } from '../control/caption.js';
import { FX, playFx, playSoundFx } from './fx.js';

const CLEAR_AFTER_MS = 6000; // captions fade after this much silence

const stage = document.getElementById('stage');
const calib = document.getElementById('calib');
const calibFill = calib.querySelector('.fill');
const params = new URLSearchParams(location.search);
if (params.has('bg')) document.body.classList.add('debug-bg');

let settings = { SHOUT_POP: true, COLORBLIND_PALETTE: false };
// Look: subtitle font and reduce motion. The control panel sets them live; for OBS they can
// also be fixed in the URL (?font=comic&motion=reduce), which wins over everything else.
const look = { font: params.get('font'), reduce: params.has('motion') ? params.get('motion') === 'reduce' : null };
const systemReduce = matchMedia('(prefers-reduced-motion: reduce)');
let reduceMotion = false;
function setFont(font) {
  font = params.get('font') || font;
  if (!(font in FONTS)) font = 'flex';
  for (const id of Object.keys(FONTS)) document.body.classList.toggle(`font-${id}`, id === font);
}
function setReduceMotion(reduce) {
  reduceMotion = look.reduce ?? (!!reduce || systemReduce.matches);
  document.body.classList.toggle('reduce-motion', reduceMotion);
}
setFont(look.font);
setReduceMotion(false);
fetch('/config').then((r) => r.json()).then((c) => {
  settings = { ...settings, ...c };
  document.body.classList.toggle('colorblind', !!settings.COLORBLIND_PALETTE);
  setFont(settings.CAPTION_FONT);
  setReduceMotion(settings.REDUCE_MOTION);
}).catch(() => {});

// Roll-up captions in one lane: words keep appending to the bottom row; when
// it is full that row moves up and the oldest row drops off. Nothing is cleared
// between sentences, so the last words stay readable for context. At most
// MAX_ROWS rows are on screen. Rows are left-aligned so words already on screen
// never shift sideways.
const MAX_ROWS = 2;
const KEEP_LINES = 12;           // caption lines a lane remembers (only the visible tail is drawn)
const STAGGER_MS = 90;           // words that arrive together fade in one by one
const STAGGER_MAX_MS = 450;

/** @type {Map<string, Lane>} the caption lane ('all'), while it is on screen */
const lanes = new Map();

/**
 * @typedef {{ key: string, el: HTMLElement, rowsEl: HTMLElement,
 *   lines: Map<number, { emotion: string, provisional: boolean, words: object[] }>,
 *   spans: Map<string, HTMLElement>, startKey: string | null, lastAt: number, fadeTimer?: number }} Lane
 */

function getLane(key) {
  let lane = lanes.get(key);
  if (lane) return lane;
  const el = document.createElement('div');
  el.className = 'lane';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'rows';
  el.append(rowsEl);
  lane = { key, el, rowsEl, lines: new Map(), spans: new Map(), startKey: null, lastAt: 0 };
  stage.appendChild(el);
  lanes.set(key, lane);
  return lane;
}

function renderLine(msg) {
  const existing = lanes.get('all');
  // A revision can drop every word (e.g. someone else's line in main-speaker mode): take it off screen.
  if (!msg.words.length) {
    if (existing?.lines.delete(msg.line)) layout(existing);
    return;
  }
  const lane = getLane('all');
  lane.lines.set(msg.line, { emotion: msg.emotion || 'neutral', provisional: !!msg.provisional, words: msg.words });
  lane.lastAt = performance.now();
  lane.el.classList.remove('fading');
  scheduleFade(lane);
  while (lane.lines.size > KEEP_LINES) lane.lines.delete(Math.min(...lane.lines.keys()));
  layout(lane);
}

/** The lane's words in order, each with its line's emotion; an emotion icon opens each tinted line. */
function tokens(lane) {
  const out = [];
  for (const id of [...lane.lines.keys()].sort((a, b) => a - b)) {
    const l = lane.lines.get(id);
    if (l.emotion !== 'neutral' && ICONS[l.emotion]) out.push({ key: `${id}:icon`, icon: ICONS[l.emotion], index: 0, ...l });
    l.words.forEach((w, i) => out.push({ key: `${id}:${i}`, w, index: i, ...l }));
  }
  return out;
}

function spanFor(lane, t, fresh) {
  let span = lane.spans.get(t.key);
  const isNew = !span;
  if (isNew) {
    span = document.createElement('span');
    span.addEventListener('animationend', () => span.classList.remove('enter', 'pop')); // moving rows must not replay it
    lane.spans.set(t.key, span);
  }
  span.className = `${t.icon ? 'icon' : 'w'} ${t.emotion}${t.provisional ? ' provisional' : ''}${t.w?.event ? ' event' : ''}`;
  let enterDelay = 0;
  if (t.icon) {
    span.textContent = t.icon;
  } else {
    const w = t.w;
    const prevLevel = span.dataset.level;
    span.dataset.level = w.level;
    span.textContent = w.word;
    span.style.setProperty('--size', w.size);
    span.style.setProperty('--wght', w.wght);
    span.style.setProperty('--wdth', w.wdth);
    span.style.setProperty('--op', w.level === 'whisper' ? 0.85 : 1);
    const shout = w.level === 'shout' && settings.SHOUT_POP;
    if (isNew || (shout && prevLevel !== 'shout')) {
      // Emotions that play "together" (surprised) also fade in together.
      const together = !t.provisional && FX[t.emotion]?.together;
      enterDelay = isNew && !together ? Math.min(fresh.n++ * STAGGER_MS, STAGGER_MAX_MS) : 0;
      span.style.animationDelay = `${enterDelay}ms`;
      span.classList.add(shout ? 'pop' : 'enter');
    }
  }
  // The line's emotion is final (not the live guess): play its animation once per emotion.
  if (!t.provisional && span.dataset.fx !== t.emotion) {
    span.dataset.fx = t.emotion;
    if (!reduceMotion && !(t.w?.event && playSoundFx(span, t.w.event, enterDelay))) {
      playFx(span, t.emotion, { index: t.index, icon: !!t.icon, delay: enterDelay });
    }
  }
  return span;
}

function newRow(lane) {
  const row = document.createElement('div');
  row.className = 'line';
  lane.rowsEl.appendChild(row);
  return row;
}

/**
 * Fill rows left to right from the first visible word; when the words need
 * more rows than the lane has, the top row is dropped (roll-up). Break points
 * only depend on the words before them, so rows never reflow as words arrive.
 */
function layout(lane, { refill = false } = {}) {
  const rowsMax = MAX_ROWS;
  const all = tokens(lane);
  const keys = new Set(all.map((t) => t.key));
  for (const [k, span] of lane.spans) if (!keys.has(k)) { span.remove(); lane.spans.delete(k); }
  if (!all.length) { lane.el.remove(); lanes.delete(lane.key); layoutAll(); return; }

  // refill (a new font or window size): lay out the remembered words again from the top.
  let start = refill ? 0 : Math.max(0, all.findIndex((t) => t.key === lane.startKey));
  const fresh = { n: 0 };
  const max = stage.clientWidth;
  for (;;) {
    lane.rowsEl.replaceChildren();
    const rows = [newRow(lane)];
    const starts = [start];
    let width = 0;
    for (let i = start; i < all.length; i++) {
      const span = spanFor(lane, all[i], fresh);
      rows.at(-1).appendChild(span);
      width += span.offsetWidth;
      if (width > max && rows.at(-1).children.length > 1) {
        span.remove();
        const row = newRow(lane);
        row.appendChild(span);
        rows.push(row);
        starts.push(i);
        width = span.offsetWidth;
      }
    }
    if (rows.length <= rowsMax) break;
    start = starts[rows.length - rowsMax]; // roll up: the oldest rows scroll off
  }
  lane.startKey = all[start].key;
}

/** Word widths changed (font, window size): lay the words out again. */
function layoutAll() { for (const lane of [...lanes.values()]) layout(lane, { refill: true }); }

/** The captions fade after CLEAR_AFTER_MS of silence. */
function scheduleFade(lane) {
  clearTimeout(lane.fadeTimer);
  lane.fadeTimer = setTimeout(() => {
    lane.el.classList.add('fading');
    // Check it's still this lane and still quiet: it may have spoken again meanwhile.
    setTimeout(() => {
      if (lanes.get(lane.key) === lane && lane.el.classList.contains('fading')) { lane.el.remove(); lanes.delete(lane.key); layoutAll(); }
    }, 450);
  }, CLEAR_AFTER_MS);
}

function clearAll() {
  for (const lane of lanes.values()) { clearTimeout(lane.fadeTimer); lane.el.remove(); }
  lanes.clear();
}

addEventListener('resize', layoutAll);
document.fonts?.addEventListener('loadingdone', layoutAll); // a font that just loaded changes word widths

function handle(msg) {
  switch (msg.type) {
    case 'line': renderLine(msg); break;
    case 'calib':
      calib.hidden = msg.progress >= 1 || msg.progress < 0;
      calibFill.style.width = `${Math.round(Math.max(0, msg.progress) * 100)}%`;
      break;
    case 'pack':
      document.body.className = document.body.className.replace(/pack-\S+/g, '').trim();
      document.body.classList.add(`pack-${msg.pack}`);
      break;
    case 'font': setFont(msg.font); layoutAll(); break; // a new font has new word widths
    case 'motion': setReduceMotion(msg.reduce); break;
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
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' })); // the control panel answers with the current look
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();
window.loudtype = { handle }; // for debugging from the console
