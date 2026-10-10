// Starts a real copy of server.js on a free port (never 7777) and sends it
// hostile requests. Skipped when config.js is missing. Never calls /token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';

// LOUDTYPE_SERVER points the test at another copy (used to check it fails on the old server).
const SERVER = process.env.LOUDTYPE_SERVER || fileURLToPath(new URL('../server.js', import.meta.url));
const skip = !existsSync(join(dirname(SERVER), 'config.js')) && 'config.js missing';

let child, port, stderr = '';

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
});

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, body: bytes.toString() });
      });
    }).on('error', reject);
  });
}

// Raw HTTP so the test can send a Host header no normal client would.
function raw(text) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    s.on('data', (d) => { buf += d; });
    s.on('end', () => resolve(buf));
    s.on('error', reject);
  });
}

// Resolves 'open', or the HTTP status the server refused the upgrade with.
function relayConnect(options = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, options);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('error', (err) => resolve(`error: ${err.message}`));
  });
}

async function assertAlive() {
  assert.equal(child.exitCode, null, `server exited:\n${stderr}`);
  assert.equal((await get('/control/')).status, 200);
}

before(async () => {
  if (skip) return;
  port = await freePort();
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, LOUDTYPE_PORT: String(port) } });
  child.stderr.on('data', (d) => { stderr += d; });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('Loudtype running')) resolve(); });
    child.on('exit', (code) => reject(new Error(`server exited (${code}):\n${stderr}`)));
  });
});

after(() => child?.kill());

test('serves the control panel and redirects the root', { skip }, async () => {
  const page = await get('/control/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal((await get('/')).status, 302);
});

test('files arrive byte-for-byte with their length and type', { skip }, async () => {
  const root = dirname(SERVER);
  for (const [path, file, type] of [
    ['/control/index.html', 'control/index.html', /text\/html/],
    ['/fonts/RobotoFlex.woff2', 'fonts/RobotoFlex.woff2', /font\/woff2/],
    ['/overlay/', 'overlay/index.html', /text\/html/],
  ]) {
    const res = await get(path);
    const want = readFileSync(join(root, file));
    assert.equal(res.status, 200, path);
    assert.match(res.headers['content-type'], type, path);
    assert.equal(Number(res.headers['content-length']), want.length, path);
    assert.ok(res.bytes.equals(want), path);
  }
  assert.equal((await get('/models/')).status, 404); // a folder without index.html
});

test('/config never includes the API key', { skip }, async () => {
  const res = await get('/config');
  assert.equal(res.status, 200);
  assert.ok(!('ELEVENLABS_API_KEY' in JSON.parse(res.body)));
});

test('an encoded ../ cannot reach config.js or server code', { skip }, async () => {
  for (const path of ['/control/..%2Fconfig.js', '/control/..%2fconfig.js', '/models/..%2Fserver.js', '/config.js']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    assert.ok(!res.body.includes('ELEVENLABS_API_KEY'), path);
  }
});

test('a malformed %-escape gets a 404 and the server stays up', { skip }, async () => {
  assert.equal((await get('/control/%ZZ')).status, 404);
  await assertAlive();
});

test('a malformed Host header is refused and the server stays up', { skip }, async () => {
  const res = await raw('GET /control/ HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
  assert.match(res, /^HTTP\/1\.1 403/);
  await assertAlive();
});

test('a URL that cannot be parsed gets a 400 and the server stays up', { skip }, async () => {
  const res = await raw(`GET http://[bad/ HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
  assert.match(res, /^HTTP\/1\.1 400/);
  await assertAlive();
});

// DNS rebinding: an outside domain resolved to 127.0.0.1 arrives with its own Host.
test('requests for a non-loopback Host are refused (DNS rebinding)', { skip }, async () => {
  for (const path of ['/token', '/config', '/control/']) {
    const res = await raw(`GET ${path} HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`);
    assert.match(res, /^HTTP\/1\.1 403/, path);
  }
  assert.equal((await get('/config')).status, 200); // 127.0.0.1 still works
  const viaLocalhost = await raw(`GET /control/ HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
  assert.match(viaLocalhost, /^HTTP\/1\.1 200/);
});

test('the relay only accepts pages this server served', { skip }, async () => {
  assert.equal(await relayConnect({ origin: `http://localhost:${port}` }), 'open');
  assert.equal(await relayConnect({ origin: `http://127.0.0.1:${port}` }), 'open');
  for (const origin of ['https://evil.example', `http://localhost:${port + 1}`, 'null', `https://localhost:${port}`]) {
    assert.equal(await relayConnect({ origin }), 401, origin);
  }
});

test('the relay passes messages between pages', { skip }, async () => {
  const origin = `http://localhost:${port}`;
  const open = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { origin });
    ws.on('open', () => resolve(ws));
  });
  const [control, overlay] = await Promise.all([open(), open()]);
  const got = new Promise((resolve) => overlay.on('message', (d) => resolve(String(d))));
  control.send(JSON.stringify({ type: 'clear' }));
  assert.deepEqual(JSON.parse(await got), { type: 'clear' });
  control.close(); overlay.close();
});

test('the relay refuses a non-loopback Host', { skip }, async () => {
  assert.equal(await relayConnect(), 'open');
  assert.equal(await relayConnect({ headers: { Host: `evil.example:${port}` } }), 401);
});

test('pages are cross-origin isolated (multi-threaded emotion model)', { skip }, async () => {
  for (const path of ['/control/', '/overlay/', '/vendor/ort/ort.wasm.min.mjs', '/config']) {
    const res = await get(path);
    assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin', path);
    assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp', path);
  }
});
