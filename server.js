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
