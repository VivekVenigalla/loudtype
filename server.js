// Loudtype local server: static files, ElevenLabs token minting, and a
// localhost-only caption relay. Stores nothing.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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

function send(res, code, body, type = 'text/plain') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') return res.writeHead(302, { Location: '/control/' }).end();
  if (url.pathname === '/token') return mintToken(res);
  if (url.pathname === '/config') {
    const { ELEVENLABS_API_KEY, ...pub } = CONFIG; // never expose the key
    return send(res, 200, JSON.stringify(pub), 'application/json');
  }
  let file = resolvePath(url.pathname);
  if (!file) return send(res, 404, 'Not found');
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    send(res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found');
  }
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
const wss = new WebSocketServer({ server, path: '/relay' });
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
