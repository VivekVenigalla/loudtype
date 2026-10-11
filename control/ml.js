// transformers.js, set up once for every on-device model (emotion.js,
// voiceprint.js): models load from /models only, never from the network.
import * as transformers from '/vendor/transformers/transformers.min.js';

const { env } = transformers;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = '/vendor/ort/';
// Threads need cross-origin isolation (server.js sends the headers); else one.
env.backends.onnx.wasm.numThreads = globalThis.crossOriginIsolated
  ? Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)))
  : 1;

export { transformers };
