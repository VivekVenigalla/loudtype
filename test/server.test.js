// Starts a real copy of server.js on a free port (never 7777) and sends it
// hostile requests. Skipped when config.js is missing. Never calls /token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';

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
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
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

test('a malformed Host header gets a 400 and the server stays up', { skip }, async () => {
  const res = await raw('GET /control/ HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
  assert.match(res, /^HTTP\/1\.1 400/);
  await assertAlive();
});
