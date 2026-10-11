// Export: .srt captions and an After Effects script that rebuilds every line
// as an editable text layer with word timing, size keyframes, color, the
// emotion's animation, and markers on the loudest and most emotional moments.
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

// The overlay's emotion animations (overlay/fx.js) as After Effects text animators.
// Each animator moves one text property; an Expression Selector (based on words)
// sets how much, per word, from the moment that word appears (its Source Text
// keyframe), so every word plays it as it is spoken, like on stream.
// Amount bodies set `a` (-100..100) from `t` = seconds since this word appeared
// (or since the line started, for emotions that move in step) and `k` = the word's
// place in the line, 0..1. Sizes are in px for the 72 px caption (1 em = 72 px).
// Keep these ES3 and ASCII: older After Effects evaluates expressions with ExtendScript.
const AE_FX = {
  angry: [ // shakes sideways 3 times while growing, settles 6% bigger
    { name: 'shake', prop: 'ADBE Text Position 3D', value: [7, 0, 0],
      body: 'if (t > 0 && t < 0.52) a = Math.sin(t * 2 * Math.PI * 6) * 100 * (1 - t / 0.52);' },
    { name: 'grow', prop: 'ADBE Text Scale 3D', value: [112, 112, 100],
      body: 'if (t > 0) a = t < 0.08 ? t / 0.08 * 100 : t < 0.52 ? 100 - (t - 0.08) / 0.44 * 50 : 50;' },
  ],
  happy: [ // each word bounces up as it appears
    { name: 'bounce', prop: 'ADBE Text Position 3D', value: [0, -14, 0],
      body: 'if (t > 0 && t < 0.6) a = Math.sin(Math.PI * t / 0.6) * 100;' },
  ],
  sad: [ // fades in, sinks, then stays 15% smaller
    { name: 'shrink', prop: 'ADBE Text Scale 3D', value: [85, 85, 100],
      body: 'if (t > 0) a = Math.min(1, t / 0.66) * 100;' },
    { name: 'sink', prop: 'ADBE Text Position 3D', value: [0, 5, 0],
      body: 'if (t > 0 && t < 0.95) a = Math.sin(Math.PI * t / 0.95) * 100;' },
    { name: 'fade', prop: 'ADBE Text Opacity', value: 25,
      body: 'if (t >= 0 && t < 0.66) a = (1 - t / 0.66) * 100;' },
  ],
  calm: [ // breathes: word gaps widen and close twice, all words in step
    { name: 'breathe', prop: 'ADBE Text Position 3D', value: [6.5, 0, 0], together: true, spread: true,
      body: 'if (t > 0 && t < 3.2) { var b = Math.sin(Math.PI * t / 1.6); a = k * b * b * 100; }' },
  ],
  surprised: [ // pops from small to big and back
    { name: 'pop', prop: 'ADBE Text Scale 3D', value: [120, 120, 100],
      body: 'if (t > 0) a = t < 0.18 ? -100 + 190 * t / 0.18 : t < 0.4 ? 90 * (1 - (t - 0.18) / 0.22) : 0;' },
  ],
  scared: [ // fast tremble that flickers, then holds still
    { name: 'tremble', prop: 'ADBE Text Position 3D', value: [2.2, 1.4, 0],
      body: 'if (t > 0 && t < 0.7) a = Math.sin(t * 2 * Math.PI * 14) * 100 * (1 - t / 0.7);' },
    { name: 'flicker', prop: 'ADBE Text Opacity', value: 60,
      body: 'if (t > 0 && t < 0.6) a = Math.abs(Math.sin(t * 2 * Math.PI * 5)) * 100;' },
  ],
  disgusted: [ // leans back, wobbles, stands up straight
    { name: 'lean', prop: 'ADBE Text Skew', value: -14,
      body: 'if (t > 0 && t < 0.62) a = t < 0.22 ? t / 0.22 * 100 : t < 0.43 ? 100 - (t - 0.22) / 0.21 * 136 : -36 * (1 - (t - 0.43) / 0.19);' },
  ],
};

/**
 * The After Effects animators for one line: property, value, and the Expression
 * Selector amount with the line's word times baked in.
 * @param {string} emotion
 * @param {number[]} times  when each word of the layer's text appears (the icon counts as a word)
 */
export function aeFx(emotion, times) {
  const spec = AE_FX[emotion];
  if (!spec || !times.length) return [];
  const n = times.length;
  return spec.map((f) => {
    const T = `[${times.map((x) => +x.toFixed(3)).join(',')}]`;
    const amount = `var T = ${T}; var i = Math.min(textIndex - 1, T.length - 1);`
      + ` var t = time - T[${f.together ? 0 : 'i'}]; var k = ${n > 1 ? `i / ${n - 1}` : '0'}; var a = 0; ${f.body} [a, a, a];`;
    // Calm spreads word i by i * 6.5 px: the property holds the last word's offset, k scales it.
    const value = f.spread ? f.value.map((v, j) => (j === 0 ? +(v * Math.max(1, n - 1)).toFixed(1) : v)) : f.value;
    return { name: `Loudtype ${emotion} ${f.name}`, prop: f.prop, value, amount };
  });
}

export function highlightLabel(line) {
  const shouts = line.words.filter((w) => w.level === 'shout').length;
  const parts = [];
  if (shouts) parts.push(`SHOUT x${shouts}`);
  if (line.emotion && line.emotion !== 'neutral') parts.push(line.emotion.toUpperCase());
  return parts.join(' / ');
}

// JSON with every non-ASCII UTF-16 unit as a \uXXXX escape (valid ES3 string syntax).
const asciiJson = (value) => JSON.stringify(value)
  .replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

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
        fx: aeFx(l.emotion, [...(ICONS[l.emotion] ? [l.words[0].start] : []), ...l.words.map((w) => w.start)]),
      };
    }),
  };

  // ExtendScript is ES3: var only, no arrow functions, no template literals.
  // Keep the file pure ASCII: AE may read a .jsx without a BOM in a legacy
  // encoding, which would garble the icons and any accented words.
  return `// Loudtype -> After Effects. File > Scripts > Run Script File...
// Builds editable text layers: word-by-word Source Text, size keyframes, color,
// the emotion's animation (text animators named "Loudtype <emotion> ..."; hide
// one with its eye to turn it off), and highlight markers.
(function () {
  var data = ${asciiJson(data)};
  var skipped = 0;

  // One text animator per effect, its amount from an Expression Selector based on words.
  // Adding a property can invalidate references fetched before, so the animator
  // is looked up again (by index) before each step.
  function addFx(layer, fx) {
    for (var f = 0; f < fx.length; f++) {
      try {
        var idx = layer.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator").propertyIndex;
        var anim = function () { return layer.property("ADBE Text Properties").property("ADBE Text Animators").property(idx); };
        anim().name = fx[f].name;
        anim().property("ADBE Text Animator Properties").addProperty(fx[f].prop);
        anim().property("ADBE Text Animator Properties").property(fx[f].prop).setValue(fx[f].value);
        anim().property("ADBE Text Selectors").addProperty("ADBE Text Expressible Selector");
        var sel = function () { return anim().property("ADBE Text Selectors").property(1); };
        try { sel().property("ADBE Text Range Type2").setValue(3); } catch (e1) {} // Based On: Words
        sel().property("ADBE Text Expressible Amount").expression = fx[f].amount;
      } catch (e) {
        skipped++;
      }
    }
  }
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
    addFx(layer, line.fx);
  }
  app.endUndoGroup();
  if (skipped) alert("Loudtype: " + skipped + " emotion animation(s) could not be added in this version of After Effects; the captions are complete without them.");
  comp.openInViewer();
})();
`;
}
