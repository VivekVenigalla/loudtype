// Loudtype local server: static files, ElevenLabs token minting, and a
// localhost-only caption relay. Stores nothing.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { makeResolver } from './server-paths.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const resolvePath = makeResolver(ROOT);

let CONFIG;
try {
  ({ CONFIG } = await import('./config.js'));
} catch {
  console.error('Missing config.js. Run: cp config.example.js config.js  and add your ElevenLabs key.');
  process.exit(1);
}
// LOUDTYPE_PORT lets the tests run a second copy next to the one you stream with.
const PORT = Number(process.env.LOUDTYPE_PORT) || CONFIG.RELAY_PORT || 7777;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream', '.woff2': 'font/woff2',
};

// The browser only ever sees a short-lived single-use token, never the API key.
async function mintToken(res) {
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST',
      headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY },
    });
    const body = await r.text();
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${body}`);
    const { token } = JSON.parse(body);
    send(res, 200, JSON.stringify({ token }), 'application/json');
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), 'application/json');
  }
}

// Read a POST body of raw float32 16 kHz mono audio (at most `maxSec` seconds).
function readAudio(req, maxSec = 30) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > maxSec * 16000 * 4) { reject(new Error('too long')); req.destroy(); } else parts.push(c);
    });
    req.on('end', () => (n && n % 4 === 0 ? resolve(Buffer.concat(parts)) : reject(new Error('expected float32 PCM'))));
    req.on('error', reject);
  });
}

// float32 PCM → 16-bit WAV, for ElevenLabs' file endpoint.
function toWav(f32buf) {
  const f = new Float32Array(f32buf.buffer, f32buf.byteOffset, f32buf.length / 4);
  const out = Buffer.alloc(44 + f.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + f.length * 2, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(f.length * 2, 40);
  for (let i = 0; i < f.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f[i])) * 32767), 44 + i * 2);
  return out;
}

// Second pass: one committed line's audio through ElevenLabs' most accurate batch
// model (Scribe v2), which beats the realtime model on words. Captions sync to a
// stream delayed by seconds, so the extra ~1 s is fine. Nothing is stored here.
let batchLogging = !CONFIG.STT_ZERO_RETENTION;
async function transcribe(req, res) {
  try {
    const wav = toWav(await readAudio(req));
    const ask = async () => {
      const form = new FormData();
      form.set('model_id', CONFIG.STT_BATCH_MODEL_ID || 'scribe_v2');
      form.set('timestamps_granularity', 'word');
      form.set('tag_audio_events', 'true'); // [laughs], [sighs], [applause]...: shown as caption sound tags
      form.set('file', new Blob([wav], { type: 'audio/wav' }), 'line.wav');
      return fetch(`https://api.elevenlabs.io/v1/speech-to-text${batchLogging ? '' : '?enable_logging=false'}`, {
        method: 'POST', headers: { 'xi-api-key': CONFIG.ELEVENLABS_API_KEY }, body: form,
      });
    };
    let r = await ask();
    let body = await r.text();
    // Plans without zero retention reject enable_logging=false: transcribe with logging, as realtime does.
    if (!r.ok && !batchLogging && /logging|retention|ZRM/i.test(body)) { batchLogging = true; r = await ask(); body = await r.text(); }
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${body.slice(0, 300)}`);
    const d = JSON.parse(body);
    const words = (d.words || []).filter((w) => w.type === 'word' || w.type === 'audio_event')
      .map(({ type, text, start, end }) => ({ text, start, end, ...(type === 'audio_event' ? { event: true } : {}) }));
    send(res, 200, JSON.stringify({ text: d.text || '', words }), 'application/json');
  } catch (err) {
    send(res, 502, JSON.stringify({ error: err.message }), 'application/json');
  }
}

// Speech emotion from the voice: proxied to the local emotion2vec service
// (emotion2vec/service.py, 127.0.0.1 only) so pages stay same-origin.
async function emotion2vec(req, res) {
  try {
    const audio = await readAudio(req);
    const r = await fetch(`http://127.0.0.1:${CONFIG.EMOTION2VEC_PORT || 7790}/emotion`, { method: 'POST', body: audio });
    send(res, r.status, await r.text(), 'application/json');
  } catch (err) {
    send(res, 503, JSON.stringify({ error: `emotion2vec service unavailable: ${err.message}` }), 'application/json');
  }
}

// Cross-origin isolation lets the emotion model run on several threads
// (SharedArrayBuffer). Every page and file comes from this server, so nothing
// the pages load is blocked by it.
const HEADERS = {
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function send(res, code, body, type = 'text/plain') {
  res.writeHead(code, { ...HEADERS, 'Content-Type': type });
  res.end(body);
}

// Only answer requests addressed to this machine by a loopback name. Blocks DNS
// rebinding, where an outside site's domain is pointed at 127.0.0.1 so the
// browser treats this server as that site and lets it read /token.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLoopbackHost = (host = '') => LOOPBACK.has(host.toLowerCase().replace(/:\d+$/, ''));

async function handle(req, res) {
  if (!isLoopbackHost(req.headers.host)) return send(res, 403, 'Forbidden: unknown host');
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') return res.writeHead(302, { Location: '/control/' }).end();
  if (url.pathname === '/token') return mintToken(res);
  if (url.pathname === '/transcribe' || url.pathname === '/emotion2vec') {
    // Only this server's own pages may spend quota or send audio (same rule as the relay).
    if (req.method !== 'POST' || !isOwnOrigin(req.headers.origin)) return send(res, 403, 'Forbidden');
    return url.pathname === '/transcribe' ? transcribe(req, res) : emotion2vec(req, res);
  }
  if (url.pathname === '/config') {
    const { ELEVENLABS_API_KEY, ...pub } = CONFIG; // never expose the key
    return send(res, 200, JSON.stringify(pub), 'application/json');
  }
  let file = resolvePath(url.pathname);
  if (!file) return send(res, 404, 'Not found');
  let info;
  try {
    info = await stat(file);
    if (info.isDirectory()) info = await stat(file = join(file, 'index.html'));
  } catch {
    return send(res, 404, 'Not found');
  }
  // Stream instead of reading whole files: the emotion model alone is 125 MB.
  res.writeHead(200, {
    ...HEADERS,
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Content-Length': info.size,
  });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

// A malformed request (bad URL or Host header) must never take the server down mid-stream.
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`Bad request ${JSON.stringify(req.url)}: ${err.message}`);
    if (res.headersSent) res.destroy();
    else send(res, 400, 'Bad request');
  });
});

// Relay: whatever the control panel sends goes to every other client.
// Browsers always send Origin on WebSockets, so only pages this server served
// (control panel, overlay) get in. Any other site could otherwise read the live
// transcript or put words on stream. No Origin = not a browser page.
function isOwnOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname) && Number(u.port || 80) === PORT;
  } catch { return false; }
}
const wss = new WebSocketServer({
  server, path: '/relay',
  verifyClient: ({ req, origin }) => isLoopbackHost(req.headers.host) && isOwnOrigin(origin),
});
wss.on('error', () => {}); // listen errors are reported by server.on('error') below
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = data.toString();
    for (const c of wss.clients) if (c !== ws && c.readyState === 1) c.send(msg);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (Loudtype is probably already running).
Stop it with:  lsof -ti tcp:${PORT} | xargs kill`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Loudtype running
  Control panel:  http://localhost:${PORT}/control/
  Overlay (OBS):  http://localhost:${PORT}/overlay/`);
});
