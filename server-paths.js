// Maps a request path to a file on disk, or null when it must not be served.
// Only the whitelisted top-level folders and the two vendor mounts are public;
// config.js (the API key) and the server code never are.
import { join, normalize, relative, sep } from 'node:path';

const PUBLIC_TOP = new Set(['control', 'overlay', 'fonts', 'models', 'replay']);

export function makeResolver(root) {
  // URL prefix → folder on disk
  const mounts = [
    ['/vendor/transformers/', join(root, 'node_modules/@huggingface/transformers/dist')],
    ['/vendor/ort/', join(root, 'node_modules/onnxruntime-web/dist')],
    ['/', root],
  ];

  return function resolvePath(urlPath) {
    for (const [prefix, dir] of mounts) {
      if (!urlPath.startsWith(prefix)) continue;
      let rel;
      try { rel = decodeURIComponent(urlPath.slice(prefix.length)); } catch { return null; } // malformed %-escape
      if (rel.includes('\0')) return null;
      const full = normalize(join(dir, rel));
      if (full !== dir && !full.startsWith(dir + sep)) return null;
      // Check the whitelist on the resolved path, not the raw one:
      // "control/..%2Fconfig.js" starts with "control" but resolves to config.js.
      if (prefix === '/' && !PUBLIC_TOP.has(relative(root, full).split(sep)[0])) return null;
      return full;
    }
    return null;
  };
}
