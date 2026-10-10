// The transcript state machine with fake Scribe events, a stub prosody and
// mocked timers: partial → committed → timestamped commit.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Transcript } from '../control/transcript.js';
import { LEVELS } from '../control/caption.js';

const style = (level) => ({ level, ...LEVELS[level], wdth: 100 });
const flush = () => new Promise((resolve) => setImmediate(resolve)); // let awaited promises settle

let now, sent, finals, liveLevel, wordLevel, classifyResult, mood, clockMs, styledCount, classifyCalls;

function make() {
  const prosody = {
    frames: [],
    styleLive: (start, end, n) => Array.from({ length: n }, () => style(liveLevel)),
    styleWord: (text, start, end) => ({ ...style(wordLevel(text)), seen: [start, end] }),
  };
  const tr = new Transcript({
    prosody,
    send: (msg) => sent.push(structuredClone(msg)),
    classify: (text, levels) => { classifyCalls++; return classifyResult ? Promise.resolve({ ...classifyResult, levels }) : null; },
    mood: () => mood,
    onStyled: () => { styledCount++; },
    onFinal: (line, info) => finals.push({ line, info }),
    clock: () => clockMs,
  });
  tr.at = (t) => { now = t; prosody.frames.push({ t }); }; // audio measured up to t
  return tr;
}
const timed = (text, start = 1) => ({
  text,
  words: text.split(' ').map((w, i) => ({ text: w, start: start + i * 0.4, end: start + i * 0.4 + 0.3, type: 'word' })),
});
const lastLine = () => sent.filter((m) => m.type === 'line').at(-1);

beforeEach(() => {
  sent = []; finals = []; liveLevel = 'normal'; wordLevel = () => 'normal';
  classifyResult = null; mood = null; clockMs = 0; styledCount = 0; classifyCalls = 0;
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => mock.timers.reset());

test('a partial is sent at once, styled from the live audio', () => {
  const tr = make();
  liveLevel = 'shout';
  tr.at(5);
  tr.partial('we won');
  assert.deepEqual(lastLine(), {
    type: 'line', line: 1, final: false, provisional: true, emotion: 'neutral', confidence: 0,
    words: [{ word: 'we', ...style('shout') }, { word: 'won', ...style('shout') }],
  });
});

test('words keep their first style as the partial grows; revisions can shrink it', () => {
  const tr = make();
  tr.at(5); liveLevel = 'whisper'; tr.partial('shh this');
  tr.at(6); liveLevel = 'shout'; tr.partial('shh this IS');
  assert.deepEqual(lastLine().words.map((w) => w.level), ['whisper', 'whisper', 'shout']);
  tr.partial('shh');
  assert.deepEqual(lastLine().words.map((w) => w.word), ['shh']);
  assert.equal(tr.current.styles.length, 1);
});

test('blank partials are ignored', () => {
  const tr = make();
  tr.partial('   ');
  assert.equal(sent.length, 0);
});

test('a timestamped commit restyles words from their real timing, then finalizes', async () => {
  const tr = make();
  tr.t0 = 100;
  tr.at(103); tr.partial('best day ever');
  wordLevel = (w) => (w === 'ever' ? 'loud' : 'normal');
  classifyResult = { emotion: 'happy', confidence: 0.876 };
  await tr.committedTimed(timed('best day ever'));
  const [provisional, final] = sent.slice(-2);
  assert.equal(provisional.final, false);
  assert.equal(final.final, true);
  assert.equal(final.line, 1);
  assert.equal(final.emotion, 'happy');
  assert.equal(final.confidence, 0.88);
  assert.deepEqual(final.words.map((w) => [w.word, w.level, w.start]), [['best', 'normal', 1], ['day', 'normal', 1.4], ['ever', 'loud', 1.8]]);
  assert.deepEqual(final.words[0].seen, [101, 101.3]); // measured at t0 + timestamp
  assert.equal(styledCount, 1);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].line.text, 'best day ever');
  assert.equal(tr.current, null);
  tr.partial('next');
  assert.equal(lastLine().line, 2);
});

test('the plain commit waits for the timestamped one and is dropped when it comes', async () => {
  const tr = make();
  tr.t0 = 0;
  tr.at(2); tr.partial('hello there');
  tr.committed('hello there');
  mock.timers.tick(300);
  await tr.committedTimed(timed('hello there'));
  mock.timers.tick(1000);
  await flush();
  assert.equal(finals.length, 1);
  assert.equal(typeof finals[0].line.words[0].start, 'number');
});

test('without timestamps the line is finalized unstyled after 600 ms', async () => {
  const tr = make();
  tr.at(2); tr.partial('hello there');
  tr.committed('hello there');
  mock.timers.tick(599);
  assert.equal(finals.length, 0);
  mock.timers.tick(1);
  await flush();
  assert.equal(finals.length, 1);
  assert.deepEqual(finals[0].line.words, [{ word: 'hello', ...style('normal') }, { word: 'there', ...style('normal') }]);
});

test('a plain commit repeating the last line within 3 s is ignored', async () => {
  const tr = make();
  tr.t0 = 0;
  await tr.committedTimed(timed('gg'));
  clockMs = 2000;
  tr.committed('gg');
  mock.timers.tick(1000);
  await flush();
  assert.equal(finals.length, 1);
  clockMs = 6000; // later, the same words are a new line
  tr.committed('gg');
  mock.timers.tick(600);
  await flush();
  assert.equal(finals.length, 2);
});

test('an empty commit drops the line being spoken', () => {
  const tr = make();
  tr.at(1); tr.partial('uh');
  tr.committedTimed({ text: '', words: [] });
  assert.equal(tr.current, null);
});

test('while the emotion model loads, lines stay neutral', async () => {
  const tr = make();
  tr.t0 = 0;
  await tr.committedTimed(timed('this is the best day ever'));
  assert.equal(lastLine().emotion, 'neutral');
  assert.equal(lastLine().confidence, 0);
  assert.equal(finals[0].info, null);
});

test('a provisional tint arrives after four words, one classification at a time', async () => {
  const tr = make();
  classifyResult = { emotion: 'angry', confidence: 0.9 };
  tr.at(1); tr.partial('why does this');
  await flush();
  assert.equal(lastLine().emotion, 'neutral');
  tr.at(2); tr.partial('why does this keep');
  tr.partial('why does this keep happening'); // still classifying: no second call
  assert.equal(classifyCalls, 1);
  await flush();
  assert.equal(lastLine().emotion, 'angry');
  assert.equal(lastLine().provisional, true);
});

test('a forced mood wins over the model, live and final', async () => {
  const tr = make();
  tr.t0 = 0;
  classifyResult = { emotion: 'happy', confidence: 0.9 };
  mood = 'sad';
  tr.at(1); tr.partial('we won');
  assert.equal(lastLine().emotion, 'sad');
  await tr.committedTimed(timed('we won'));
  assert.equal(lastLine().emotion, 'sad');
  assert.equal(lastLine().confidence, 1);
});

test('refresh re-sends the line being spoken (mood hotkey)', () => {
  const tr = make();
  tr.at(1); tr.partial('okay chat');
  mood = 'calm';
  tr.refresh();
  assert.equal(lastLine().emotion, 'calm');
  assert.equal(sent.length, 2);
});

test('learns the partial lag from when words appeared vs. when they ended', async () => {
  const tr = make();
  tr.t0 = 10;
  assert.equal(tr.partialLag(), 1); // default until measured
  tr.at(12.6); tr.partial('one two three');
  await tr.committedTimed(timed('one two three')); // ends 11.3, 11.7, 12.1 → seen at 12.6
  assert.deepEqual(tr.lags.map((x) => +x.toFixed(2)), [1.3, 0.9, 0.5]);
  assert.equal(+tr.partialLag().toFixed(2), 0.9);
});

test('after close, events are ignored and a waiting plain commit never fires', async () => {
  const tr = make();
  tr.at(1); tr.partial('bye');
  tr.committed('bye');
  tr.close();
  tr.partial('more');
  tr.committedTimed(timed('more'));
  mock.timers.tick(1000);
  await flush();
  assert.equal(finals.length, 0);
  assert.equal(sent.length, 1);
});

test('each session keeps its own timed lines for export', async () => {
  const a = make(), b = make();
  a.t0 = 0; b.t0 = 0;
  await a.committedTimed(timed('first session'));
  a.committed('no timestamps here');
  mock.timers.tick(600);
  await flush();
  await b.committedTimed(timed('second session'));
  assert.deepEqual(a.lines.map((l) => l.text), ['first session']); // untimed lines can't be exported
  assert.deepEqual(b.lines.map((l) => l.text), ['second session']);
});

test('a line still being classified when the session closes stays in that session', async () => {
  const tr = make();
  tr.t0 = 0;
  let resolve;
  tr.classify = () => new Promise((r) => { resolve = r; });
  const done = tr.committedTimed(timed('last words'));
  tr.close();
  resolve({ emotion: 'calm', confidence: 0.8 });
  await done;
  assert.deepEqual(tr.lines.map((l) => [l.text, l.emotion]), [['last words', 'calm']]);
});

test('a timestamped commit arriving after the 600 ms wait upgrades that line in place', async () => {
  const tr = make();
  tr.t0 = 0;
  classifyResult = { emotion: 'happy', confidence: 0.9 };
  tr.at(2); tr.partial('we won');
  tr.committed('we won');
  mock.timers.tick(600);
  await flush();                                   // finalized untimed as line 1
  clockMs = 800;
  await tr.committedTimed(timed('we won'));        // late
  const lineIds = new Set(sent.filter((m) => m.type === 'line').map((m) => m.line));
  assert.deepEqual([...lineIds], [1]);             // no second line on the overlay
  assert.equal(typeof lastLine().words[0].start, 'number');
  assert.equal(sent.at(-2).emotion, 'happy');      // keeps its tint while re-classifying
  assert.deepEqual(tr.lines.map((l) => l.line), [1]);
  tr.partial('next');
  assert.equal(lastLine().line, 2);
});

test('a late timestamped commit does not overwrite the next line being spoken', async () => {
  const tr = make();
  tr.t0 = 0;
  tr.at(2); tr.partial('first line');
  tr.committed('first line');
  mock.timers.tick(600);
  await flush();
  tr.at(3); tr.partial('second line starts');      // line 2 in progress
  clockMs = 900;
  await tr.committedTimed(timed('first line'));
  assert.equal(lastLine().line, 1);
  assert.equal(tr.current.id, 2);
  assert.equal(tr.current.text, 'second line starts');
  tr.partial('second line starts here');
  assert.equal(lastLine().line, 2);
});

test('a late upgrade wins even if the plain version is still classifying', async () => {
  const tr = make();
  tr.t0 = 0;
  const pending = [];
  tr.classify = () => new Promise((r) => pending.push(r));
  tr.at(2); tr.partial('hold on');
  tr.committed('hold on');
  mock.timers.tick(600);                           // untimed finalize starts classifying
  clockMs = 700;
  const upgrade = tr.committedTimed(timed('hold on'));
  pending[1]({ emotion: 'calm', confidence: 0.8 }); // the timed one resolves first...
  await upgrade;
  pending[0]({ emotion: 'angry', confidence: 0.9 }); // ...then the stale untimed one
  await flush();
  const finalsSent = sent.filter((m) => m.final);
  assert.equal(finalsSent.length, 1);
  assert.equal(finalsSent[0].emotion, 'calm');
  assert.equal(typeof finalsSent[0].words[0].start, 'number');
  assert.deepEqual(finals.map((f) => f.line.emotion), ['calm']);
});
