// Overlay: draws what the control panel sends. Holds no state worth saving,
// so OBS can reload it at any time.
import { ICONS } from '../control/caption.js';

const CLEAR_AFTER_MS = 6000; // a speaker's captions fade after this much of their silence

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

// Roll-up captions, one lane per speaker ("thread"): words keep appending to
// the bottom row; when it is full that row moves up and the oldest row drops
// off. Nothing is cleared between sentences, so the last words stay readable
// for context. At most MAX_ROWS rows are on screen in total: one speaker gets
// both rows; two speakers get one row each (the two most recently active).
// Rows are left-aligned so words already on screen never shift sideways.
const MAX_ROWS = 2;
const MAX_LANES = 2;
const KEEP_LINES = 12;           // caption lines a lane remembers (only the visible tail is drawn)
const STAGGER_MS = 90;           // words that arrive together fade in one by one
const STAGGER_MAX_MS = 450;

/** @type {Map<string, Lane>} speaker key ('1', '2', … or 'all') → lane */
const lanes = new Map();

/**
 * @typedef {{ key: string, el: HTMLElement, tag: HTMLElement, rowsEl: HTMLElement,
 *   lines: Map<number, { emotion: string, provisional: boolean, words: object[] }>,
 *   spans: Map<string, HTMLElement>, startKey: string | null, lastAt: number, fadeTimer?: number }} Lane
 */

function getLane(key, speaker) {
  let lane = lanes.get(key);
  if (lane) return lane;
  const el = document.createElement('div');
  el.className = 'lane';
  const tag = document.createElement('span');
  tag.className = 'speaker';
  tag.textContent = speaker ? `S${speaker}` : '';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'rows';
  el.append(rowsEl);
  lane = { key, el, tag, rowsEl, lines: new Map(), spans: new Map(), startKey: null, lastAt: 0 };
  // A third speaker takes the place (on screen) of the one quiet the longest, so nothing jumps.
  const visible = [...lanes.values()];
  if (visible.length >= MAX_LANES) {
    const old = visible.reduce((a, b) => (a.lastAt <= b.lastAt ? a : b));
    old.el.replaceWith(el);
    lanes.delete(old.key);
  } else {
    stage.appendChild(el);
  }
  lanes.set(key, lane);
  for (const other of [...lanes.values()]) if (other !== lane) layout(other); // they now share the rows
  return lane;
}

const laneKey = (w, msg) => String(w.speaker ?? msg.speaker ?? 'all');

function renderLine(msg) {
  // A line's words can belong to different speakers (turns inside one commit).
  const groups = new Map();
  for (const w of msg.words) {
    const k = laneKey(w, msg);
    if (!groups.has(k)) groups.set(k, { speaker: w.speaker ?? msg.speaker, words: [] });
    groups.get(k).words.push(w);
  }
  // Revisions can move or drop words: take this line out of lanes it no longer has words in.
  for (const lane of lanes.values()) {
    if (lane.lines.has(msg.line) && !groups.has(lane.key)) { lane.lines.delete(msg.line); layout(lane); }
  }
  const now = performance.now();
  for (const [k, g] of groups) {
    const lane = getLane(k, g.speaker);
    lane.lines.set(msg.line, { emotion: msg.emotion || 'neutral', provisional: !!msg.provisional, words: g.words });
    lane.lastAt = now;
    lane.el.classList.remove('fading');
    scheduleFade(lane);
    while (lane.lines.size > KEEP_LINES) lane.lines.delete(Math.min(...lane.lines.keys()));
    layout(lane);
  }
}

/** The lane's words in order, each with its line's emotion; an emotion icon opens each tinted line. */
function tokens(lane) {
  const out = [];
  for (const id of [...lane.lines.keys()].sort((a, b) => a - b)) {
    const l = lane.lines.get(id);
    if (l.emotion !== 'neutral' && ICONS[l.emotion]) out.push({ key: `${id}:icon`, icon: ICONS[l.emotion], ...l });
    l.words.forEach((w, i) => out.push({ key: `${id}:${i}`, w, ...l }));
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
  span.className = `${t.icon ? 'icon' : 'w'} ${t.emotion}${t.provisional ? ' provisional' : ''}`;
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
      span.style.animationDelay = isNew ? `${Math.min(fresh.n++ * STAGGER_MS, STAGGER_MAX_MS)}ms` : '0ms';
      span.classList.add(shout ? 'pop' : 'enter');
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
  const rowsMax = Math.max(1, Math.floor(MAX_ROWS / Math.max(1, lanes.size)));
  const all = tokens(lane);
  const keys = new Set(all.map((t) => t.key));
  for (const [k, span] of lane.spans) if (!keys.has(k)) { span.remove(); lane.spans.delete(k); }
  if (!all.length) { lane.el.remove(); lanes.delete(lane.key); layoutAll(); return; }

  // refill: the lane just got more rows (another speaker left), so lay out its remembered words again from the top.
  let start = refill ? 0 : Math.max(0, all.findIndex((t) => t.key === lane.startKey));
  const fresh = { n: 0 };
  const max = stage.clientWidth;
  for (;;) {
    lane.rowsEl.replaceChildren();
    const rows = [newRow(lane)];
    if (lane.tag.textContent) rows[0].appendChild(lane.tag);
    const indent = lane.tag.textContent ? lane.tag.offsetWidth : 0;
    const starts = [start];
    let width = indent;
    for (let i = start; i < all.length; i++) {
      const span = spanFor(lane, all[i], fresh);
      rows.at(-1).appendChild(span);
      width += span.offsetWidth;
      if (width > max && rows.at(-1).children.length > (rows.length === 1 && indent ? 2 : 1)) {
        span.remove();
        const row = newRow(lane);
        row.style.paddingLeft = `${indent}px`; // later rows line up under the first word, not the tag
        row.appendChild(span);
        rows.push(row);
        starts.push(i);
        width = indent + span.offsetWidth;
      }
    }
    if (rows.length <= rowsMax) break;
    start = starts[rows.length - rowsMax]; // roll up: the oldest rows scroll off
  }
  lane.startKey = all[start].key;
}

/** The number of lanes changed: every lane's row count may have too. */
function layoutAll() { for (const lane of [...lanes.values()]) layout(lane, { refill: true }); }

/** Each speaker's lane fades after their own silence; the others then get its rows. */
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
