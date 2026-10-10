import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openScribe } from '../control/stt.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('a token error from the server is shown as-is', async () => {
  globalThis.fetch = async () => Response.json({ error: 'ElevenLabs 401: invalid api key' }, { status: 502 });
  await assert.rejects(openScribe({}, {}), /ElevenLabs 401: invalid api key/);
});

test('a non-JSON answer (server down, proxy page) gives a readable error', async () => {
  globalThis.fetch = async () => new Response('<html>Bad Gateway</html>', { status: 502 });
  await assert.rejects(openScribe({}, {}), /speech-to-text token.*502/);
});
