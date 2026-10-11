// Emotion preview: every emotion's sample line, animated with the overlay's own code,
// plus an approve / change-it checklist whose notes copy as text for Claude.
import { ICONS, EMOTIONS, EMOTION_COLORS, FONTS, LEVELS } from '../control/caption.js';
import { FX, playFx } from './fx.js';

const SAMPLES = {
  happy: "Let's go, we actually won the whole thing!",
  calm: 'Thanks for hanging out with me tonight.',
  angry: 'Are you kidding me? That was so unfair!',
  sad: "We lost again. I'm just tired.",
  surprised: 'Wait, what just happened?',
  scared: "Something is behind me, I'm freaking out.",
  disgusted: 'Ew, that is so gross.',
  neutral: 'The next round starts in two minutes.',
};

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const feedback = store.get('loudtype.fxFeedback', {});
const cards = new Map();

for (const [id, name] of Object.entries(FONTS)) $('font').add(new Option(name, id));

function wordSpan(word, emotion) {
  const span = document.createElement('span');
  span.className = `w ${emotion}`;
  span.dataset.level = 'normal';
  span.textContent = word;
  span.style.setProperty('--size', String(LEVELS.normal.size));
  span.style.setProperty('--wght', String(LEVELS.normal.wght));
  span.style.setProperty('--wdth', '100');
  return span;
}

function play(emotion) {
  const { line } = cards.get(emotion);
  line.replaceChildren();
  if (ICONS[emotion]) {
    const icon = document.createElement('span');
    icon.className = `icon ${emotion}`;
    icon.textContent = ICONS[emotion];
    line.append(icon);
  }
  SAMPLES[emotion].split(' ').forEach((w) => line.append(wordSpan(w, emotion)));
  const reduce = $('reduce').checked;
  [...line.children].forEach((el, i) => {
    const isIcon = el.classList.contains('icon');
    const delay = FX[emotion].together ? 0 : Math.min(i * 90, 450); // as the overlay staggers the fade-in
    el.classList.add('enter'); // the overlay's fade-in
    el.style.animationDelay = `${delay}ms`;
    el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
    if (!reduce) playFx(el, emotion, { index: isIcon ? 0 : i - (ICONS[emotion] ? 1 : 0), icon: isIcon, delay });
  });
}
const playAll = () => EMOTIONS.forEach((e) => { play(e); repeat(e); });

// "Send to overlay": the same events the control panel sends (live guess, then final).
let ws = null, lineId = 900000;
function relay() {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://${location.host}/relay`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('relay not reachable'));
  });
}
async function sendToOverlay(emotion) {
  try {
    const sock = await relay();
    const words = SAMPLES[emotion].split(' ').map((word) => ({ word, level: 'normal', size: 1, wght: 450, wdth: 100 }));
    const line = ++lineId;
    sock.send(JSON.stringify({ type: 'line', line, final: false, provisional: true, emotion: 'neutral', confidence: 0, words }));
    setTimeout(() => sock.send(JSON.stringify({ type: 'line', line, final: true, provisional: false, emotion, confidence: 1, words })), 700);
    say(`Sent "${emotion}" to the overlay`);
  } catch (err) { say(`Could not reach the overlay relay: ${err.message}`); }
}

function say(text) { $('msg').textContent = text; clearTimeout(say.t); say.t = setTimeout(() => { $('msg').textContent = ''; }, 3000); }

function card(emotion) {
  const el = document.createElement('section');
  el.className = 'card';
  el.innerHTML = `
    <div class="head"><span class="swatch"></span><span class="name"></span><span class="icon-label"></span></div>
    <div class="about"></div>
    <div class="view"><div class="line"></div></div>
    <div class="actions">
      <button data-act="play">▶ Replay</button>
      <button data-act="send">Send to overlay</button>
      <span class="verdict">
        <label><input type="radio" name="v-${emotion}" value="approved"> Approve</label>
        <label><input type="radio" name="v-${emotion}" value="changes"> Change it</label>
      </span>
      <textarea placeholder="Notes (e.g. shake less, slower, different color)"></textarea>
    </div>`;
  el.querySelector('.swatch').style.background = `var(--c-${emotion})`;
  el.querySelector('.name').textContent = emotion;
  el.querySelector('.icon-label').textContent = ICONS[emotion] ? `icon ${ICONS[emotion]}` : 'no icon';
  el.querySelector('.about').textContent = FX[emotion].about;
  el.querySelector('[data-act=play]').onclick = () => { play(emotion); repeat(emotion); };
  el.querySelector('[data-act=send]').onclick = () => sendToOverlay(emotion);
  const notes = el.querySelector('textarea');
  const f = feedback[emotion] ?? {};
  notes.value = f.notes ?? '';
  for (const r of el.querySelectorAll('input[type=radio]')) {
    r.checked = r.value === f.verdict;
    r.onchange = () => { feedback[emotion] = { ...feedback[emotion], verdict: r.value }; save(); };
  }
  notes.oninput = () => { feedback[emotion] = { ...feedback[emotion], notes: notes.value }; save(); };
  $('grid').append(el);
  cards.set(emotion, { el, line: el.querySelector('.line') });
  mark(emotion);
}
function mark(emotion) {
  const v = feedback[emotion]?.verdict;
  cards.get(emotion)?.el.classList.toggle('approved', v === 'approved');
  cards.get(emotion)?.el.classList.toggle('changes', v === 'changes');
}
function save() { store.set('loudtype.fxFeedback', feedback); EMOTIONS.forEach(mark); }

EMOTIONS.forEach(card);

$('copy').onclick = async () => {
  const lines = EMOTIONS.map((e) => {
    const f = feedback[e] ?? {};
    return `- ${e} (${EMOTION_COLORS[e]}${ICONS[e] ? ` ${ICONS[e]}` : ''}): ${f.verdict ?? 'not reviewed'}${f.notes ? ` — ${f.notes}` : ''}`;
  });
  const text = `Emotion animation feedback (font: ${FONTS[$('font').value]}):\n${lines.join('\n')}`;
  try { await navigator.clipboard.writeText(text); say('Feedback copied'); } catch { console.log(text); say('Could not copy; it is in the console'); }
};
$('play-all').onclick = playAll;
$('font').onchange = () => {
  for (const id of Object.keys(FONTS)) document.body.classList.toggle(`font-${id}`, id === $('font').value);
  playAll();
};
$('bg').onchange = () => { document.body.className = document.body.className.replace(/bg-\S+/g, '').trim(); document.body.classList.add(`bg-${$('bg').value}`); };
$('reduce').onchange = () => { document.body.classList.toggle('reduce-motion', $('reduce').checked); playAll(); };
$('colorblind').onchange = () => document.body.classList.toggle('colorblind', $('colorblind').checked);
// Repeat (on by default): each card replays on its own after its animation ends plus a short
// pause, so every emotion can be watched again and again.
const PAUSE_MS = 1200;
const timers = new Map();
function repeat(emotion) {
  clearTimeout(timers.get(emotion));
  if (!$('loop').checked) return;
  const fx = FX[emotion];
  const words = SAMPLES[emotion].split(' ').length;
  const length = Math.max(fx.duration + (fx.together ? 0 : words * Math.max(fx.stagger, 90)), 900);
  timers.set(emotion, setTimeout(() => { play(emotion); repeat(emotion); }, length + PAUSE_MS));
}
$('loop').onchange = () => EMOTIONS.forEach((e) => (($('loop').checked ? play(e) : 0), repeat(e)));

document.fonts.ready.then(playAll);
