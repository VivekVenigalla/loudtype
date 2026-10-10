import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeResolver } from '../server-paths.js';

const ROOT = '/proj';
const resolvePath = makeResolver(ROOT);
// The server gets paths from new URL(), which already resolves plain ../ segments.
const resolveUrl = (raw) => resolvePath(new URL(raw, 'http://localhost:7777').pathname);

test('serves files in the public folders', () => {
  assert.equal(resolveUrl('/control/app.js'), join(ROOT, 'control/app.js'));
  assert.equal(resolveUrl('/overlay/'), join(ROOT, 'overlay/'));
  assert.equal(resolveUrl('/models/SamLowe/config.json'), join(ROOT, 'models/SamLowe/config.json'));
  assert.equal(resolveUrl('/fonts/Roboto%20Flex.woff2'), join(ROOT, 'fonts/Roboto Flex.woff2'));
});

test('serves the vendor mounts from node_modules', () => {
  assert.equal(resolveUrl('/vendor/transformers/transformers.min.js'),
    join(ROOT, 'node_modules/@huggingface/transformers/dist/transformers.min.js'));
  assert.equal(resolveUrl('/vendor/ort/ort.wasm'), join(ROOT, 'node_modules/onnxruntime-web/dist/ort.wasm'));
});

test('never serves config.js or server code', () => {
  for (const raw of [
    '/config.js', '/server.js', '/server-paths.js', '/package.json',
    '/control/../config.js', '/control/%2e%2e/config.js',
    '/control/..%2Fconfig.js', '/control/..%2fconfig.js', '/models/..%2Fserver.js',
    '/control/%2E%2E%2Fconfig.js', '/replay/..%2F..%2Fetc%2Fpasswd',
  ]) assert.equal(resolveUrl(raw), null, raw);
});

test('does not let a vendor mount climb out of its folder', () => {
  assert.equal(resolveUrl('/vendor/ort/..%2F..%2F..%2Fconfig.js'), null);
  assert.equal(resolveUrl('/vendor/transformers/..%2F..%2F..%2F..%2Fconfig.js'), null);
});

test('rejects malformed escapes and NUL bytes instead of throwing', () => {
  assert.equal(resolveUrl('/control/%ZZ'), null);
  assert.equal(resolveUrl('/control/%E0%A4%A'), null);
  assert.equal(resolveUrl('/control/app.js%00.png'), null);
});

test('rejects the bare root and unknown top-level folders', () => {
  assert.equal(resolveUrl('/'), null);
  assert.equal(resolveUrl('/node_modules/ws/index.js'), null);
  assert.equal(resolveUrl('/scripts/setup.js'), null);
});
