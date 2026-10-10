// Export: .srt captions and an After Effects script that rebuilds every line
// as an editable text layer with word timing, size keyframes, color, and
// markers on the loudest and most emotional moments.
// `lines`: [{ line, text, emotion, confidence, words: [{word, level, size, wght, wdth, start, end}] }]
// Times are seconds since the session started.

import { ICONS, EMOTION_COLORS } from './caption.js';

// '#ffd84d' → [1, 0.847, 0.302], the 0..1 RGB After Effects wants.
const aeColor = (hex) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000);
const LINGER = 1.5; // seconds a caption stays after its last word

export function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

function span(line) {
  const start = line.words[0].start;
  const end = line.words.at(-1).end;
  return { start, end };
}

export function toSrt(lines) {
  const timed = lines.filter((l) => l.words.length);
  return timed.map((l, i) => {
    const { start, end } = span(l);
    const next = timed[i + 1] ? span(timed[i + 1]).start : Infinity;
    const out = Math.min(end + LINGER, Math.max(end, next - 0.05));
    return `${i + 1}\n${srtTime(start)} --> ${srtTime(out)}\n${l.text}\n`;
  }).join('\n');
}

export function highlightLabel(line) {
  const shouts = line.words.filter((w) => w.level === 'shout').length;
  const parts = [];
  if (shouts) parts.push(`SHOUT x${shouts}`);
  if (line.emotion && line.emotion !== 'neutral') parts.push(line.emotion.toUpperCase());
  return parts.join(' / ');
}

export function toAfterEffects(lines) {
  const timed = lines.filter((l) => l.words.length);
  const data = {
    duration: timed.length ? span(timed.at(-1)).end + LINGER + 1 : 10,
    lines: timed.map((l) => {
      const { start, end } = span(l);
      return {
        start, end: end + LINGER,
        prefix: ICONS[l.emotion] ? `${ICONS[l.emotion]} ` : '',
        color: aeColor(EMOTION_COLORS[l.emotion] || EMOTION_COLORS.neutral),
        marker: highlightLabel(l),
        words: l.words.map((w) => ({ t: w.start, w: w.word, s: w.size })),
      };
    }),
  };

  // ExtendScript is ES3: var only, no arrow functions, no template literals.
  return `// Loudtype → After Effects. File > Scripts > Run Script File…
// Builds editable text layers: word-by-word Source Text, size keyframes, color, highlight markers.
(function () {
  var data = ${JSON.stringify(data)};
  app.beginUndoGroup("Loudtype import");
  var comp = app.project.items.addComp("Loudtype captions", 1920, 1080, 1, Math.max(1, data.duration), 30);
  var highlights = comp.layers.addNull(data.duration);
  highlights.name = "Highlights";
  var BASE = 72;

  for (var i = 0; i < data.lines.length; i++) {
    var line = data.lines[i];
    var full = line.prefix;
    for (var k = 0; k < line.words.length; k++) full += (k ? " " : "") + line.words[k].w;

    var layer = comp.layers.addText(full);
    layer.name = "Line " + (i + 1);
    var st = layer.property("Source Text");
    var doc = st.value;
    doc.fontSize = BASE;
    doc.applyFill = true;
    doc.fillColor = line.color;
    doc.applyStroke = true;
    doc.strokeColor = [0, 0, 0];
    doc.strokeWidth = 6;
    doc.strokeOverFill = false;
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    st.setValue(doc);
    layer.property("Position").setValue([960, 960]);

    // Words appear when spoken (Source Text keyframes hold by default);
    // scale follows each word's loudness. Anchor is on the baseline.
    var shown = line.prefix;
    var scale = layer.property("Scale");
    for (var j = 0; j < line.words.length; j++) {
      var w = line.words[j];
      shown += (j ? " " : "") + w.w;
      var d = st.value;
      d.text = shown;
      st.setValueAtTime(w.t, d);
      scale.setValueAtTime(w.t, [w.s * 100, w.s * 100]);
    }
    for (var h = 1; h <= scale.numKeys; h++) {
      scale.setInterpolationTypeAtKey(h, KeyframeInterpolationType.HOLD);
    }

    layer.startTime = 0;
    layer.inPoint = line.start;
    layer.outPoint = Math.min(line.end, data.duration);

    if (line.marker) {
      highlights.property("Marker").setValueAtTime(line.start, new MarkerValue(line.marker));
    }
  }
  app.endUndoGroup();
  comp.openInViewer();
})();
`;
}
