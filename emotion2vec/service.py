"""Loudtype emotion2vec service: speech emotion from the voice itself, on this computer.

POST /emotion with a raw little-endian float32 16 kHz mono body -> JSON
{"scores": {"angry": .., "happy": .., "neutral": .., "sad": .., "surprised": .., ...}, "ms": ..}

Listens on 127.0.0.1 only; the Loudtype server (server.js) proxies /emotion2vec here,
so the browser never talks to another origin. Audio stays in memory and is never saved.
Model: emotion2vec/emotion2vec_plus_large (or EMOTION2VEC_MODEL), downloaded once from Hugging Face.
"""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

import numpy as np
from funasr import AutoModel

MODEL = os.environ.get("EMOTION2VEC_MODEL", "emotion2vec/emotion2vec_plus_large")
PORT = int(os.environ.get("EMOTION2VEC_PORT", "7790"))
MAX_SEC = 30

print(f"loading {MODEL} ...", flush=True)
model = AutoModel(model=MODEL, hub="hf", disable_update=True, log_level="ERROR")
lock = threading.Lock()  # one inference at a time


def label(name):
    # labels look like "生气/angry"; keep the English part
    return name.split("/")[-1]


def infer(audio):
    with lock:
        out = model.generate(audio, granularity="utterance", extract_embedding=False)[0]
    return {label(k): float(v) for k, v in zip(out["labels"], out["scores"])}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200, {"ok": True, "model": MODEL}) if self.path == "/health" else self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/emotion":
            return self.reply(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n % 4 or n > MAX_SEC * 16000 * 4:
            return self.reply(400, {"error": "body must be float32 16 kHz PCM, up to 30 s"})
        audio = np.frombuffer(self.rfile.read(n), dtype="<f4").astype(np.float32)
        t = time.time()
        try:
            scores = infer(audio)
        except Exception as e:  # never crash the service on one bad clip
            return self.reply(500, {"error": str(e)})
        self.reply(200, {"scores": scores, "ms": round((time.time() - t) * 1000)})


infer(np.zeros(16000, dtype=np.float32))  # warm up
print(f"emotion2vec ready on http://127.0.0.1:{PORT}", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
