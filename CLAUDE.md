# Loudtype

**Live captions that sound like you.** A live caption overlay for streamers: loud words are big and heavy, whispers small and light, held words stretch wide, and each line is tinted with its emotion. Words never move off one shared baseline.

Built for **Hacklanta '26, Creative track (Adobe)**, also entered for MLH Best Use of ElevenLabs and the Zero Data Challenge. The original product spec was pasted in chat (not in the repo); its essentials are summarized below. `DEMO.md` holds the judging-table script and Q&A; `RUN.md` the quick-start.

## Run

```bash
npm install
npm run setup                    # one-time: GoEmotions model + Roboto Flex into models/ and fonts/
cp config.example.js config.js   # add ELEVENLABS_API_KEY (config.js is gitignored and already exists locally)
npm start                        # http://localhost:7777/control/ and /overlay/
npm test                         # node:test, no network; starts its own server on a free port
```

- If `npm start` says port 7777 is in use, a server is already running: `lsof -ti tcp:7777 | xargs kill`.
- The user usually runs the server in the Terminal panel (tab 0). Don't start a second one; reload the pages instead. Server code changes need a restart; `control/`, `overlay/` changes only need a page reload.
- **The folder name `HacklantaFinal?` contains a `?`.** It breaks shell globs and `import()` of plain paths in Node. Always quote paths and use `pathToFileURL` in scripts. Recommend renaming to `Loudtype` (outside a Claude session running in it).
- Git repo since the codebase audit (`main` = baseline, audit work on branch `audit`). `models/` and `config.js` are gitignored.

## Architecture

```
Control panel (Chrome, /control/)            Overlay (/overlay/, OBS Browser Source)
  mic → AudioWorklet (pcm-worklet.js)          renders words on one baseline,
    ├─ 33 ms frames: dB + voicing ─┐           chunks, fades, colors, prompt card
    └─ 100 ms 16 kHz PCM → Scribe  │                    ▲
  ElevenLabs Scribe realtime (stt.js)          ws://localhost:7777/relay (server.js)
    partial / committed+timestamps ─┤                    │
  prosody.js: level per word ◄──────┘          caption events (JSON) ─┘
  emotion.js + emotion-core.js: line emotion
```

- **server.js** (Node, only dep `ws`): serves `control/ overlay/ fonts/ models/ replay/` (whitelisted top-level dirs only, checked in `server-paths.js` *after* resolving `..`, so `config.js` and `server.js` are never served), maps `/vendor/transformers/` → `@huggingface/transformers/dist` and `/vendor/ort/` → `onnxruntime-web/dist`. `GET /token` mints a single-use Scribe token (API key never reaches the browser). `GET /config` returns config minus the key. `/relay` rebroadcasts control → overlay; stores nothing.
- **control/**
  - `app.js`: session orchestration, partial/commit handling, emotion, replay, export, Director's View, mood hotkeys, judge prompt cards. `window.loudtype.session()` exposes the live session for debugging.
  - `audio.js` + `pcm-worklet.js`: mic with AGC/noise suppression **off** (they'd flatten loudness). All measurement happens **in the worklet** with exact `currentTime` stamps; main-thread timing was ~0.5 s off while the model loaded.
  - `features.js`: per-frame `{db, voicing}`; voicing = normalized autocorrelation peak at 70–400 Hz (whispers ≈ unvoiced). Shared by worklet and eval scripts.
  - `prosody.js`: learns the speaker's normal level (median of the first 6 *voiced* words), then levels by fixed dB offsets: whisper ≤ −10 or (voiced share < 0.3 and < +4 dB), soft ≤ −5, loud ≥ +5, shout ≥ +10. "Normal" slowly tracks the speaker (only from normal words). Noise floor = 10th percentile of the last 5 s, clamped ≥ −72 dB. Width (`wdth` 100–151) from ms-per-letter vs. the speaker's median. `styleLive()` styles partial words instantly; committed timestamps then correct them.
  - `stt.js`: Scribe realtime (`commit_strategy=vad`, `include_timestamps=true`, `vad_silence_threshold_secs` from config). Warnings surface in the status line.
  - `emotion.js` / `emotion-core.js`: GoEmotions (`SamLowe/roberta-base-go_emotions-onnx`, q8, local only) → pos/neg/neutral, a stream-slang regex layer, and energy = mostly voice levels + some text arousal. Quadrant: pos+high → happy ★ yellow, pos+low → calm ● green, neg+high → angry ▲ red, neg+low → sad ▼ blue; neutral/low confidence → white.
  - `relay.js` (ws client + in-memory recording for replay), `export.js` (`.srt` + ExtendScript `.jsx`; **ES3 only** in generated code).
- **overlay/** `render.js`: chunks long utterances (7 words or a sentence end), max 2 lines, staggered 90 ms fade-in per word, shrink-to-fit (`--fit` ≥ 0.65) before hiding oldest words, clears after 3.5 s silence. Fit uses `offsetWidth` against the stage width (transforms from the shout pop must not count). `style.css`: Studio pack, per-level outlines (thin for whispers, heavy for shouts), word spacing in `em` of each word, colorblind palette via the `.colorblind` class.

**Caption event** sent to the overlay: `{type:'line', line, final, provisional, emotion, confidence, words:[{word, level, size, wght, wdth, start?, end?}]}`. Other types: `calib {progress}`, `pack {pack}`, `prompt {text, step, of}`, `clear`.

## Design rules (from the spec; don't break them)

- One baseline. No vertical movement, rotation, shaking or size transitions. The only motion is the ~80 ms fade-in and the optional 108% shout pop.
- Each visual property means one thing: size+weight = loudness, width = held length, color+icon = emotion. Color is never the only signal (icons).
- Only tint when confident; a white line beats a wrong color.
- Zero data: no accounts or analytics, nothing written to disk except on Export/Save click, emotion runs on-device, only outside host is ElevenLabs.
- Levels: whisper 0.75×/wght 220, soft 0.9×/350, normal 1×/450, loud 1.25×/700, shout 1.6×/1000.

## Testing

- `node scripts/eval-volume.mjs [old-prosody.js]`: builds a clip with macOS `say` (incl. the `Whisper` voice) where every word's level is known, gets real Scribe timestamps (needs the key, uses network), scores levels. Last result: 48/51 exact, 51/51 within one level (old z-score method: 44/51).
- `node scripts/eval-emotion.mjs`: 30 tuning lines, 20 held-out lines, 8 voice-quadrant cases. Last result: tuning 30/30, held-out 18/20 (old SST-2: 12/20), quadrants 8/8. Don't tune on the held-out set.
- **Fake-mic browser test:** put a WAV in `replay/`, then in the control tab override `navigator.mediaDevices.getUserMedia` to return `MediaStreamDestination.stream` from an `AudioBufferSource`, click Start, and watch the overlay DOM (MutationObserver) in another tab. This is how the end-to-end pipeline was verified. Delete test WAVs afterwards.
- `node scripts/make-demo.js` regenerates the scripted offline clip `replay/demo.json`.
- Measured facts: Scribe partials arrive in bursts ~1/s, ~0.8 s after speech (learned at runtime from timestamps).

## Status

Done: priorities 1–8 of the spec (overlay, loudness → size/weight, Studio pack, emotion + icons + confidence gating, OBS transparent page, offline replay, width for held words, `.srt` + After Effects export with highlight markers), plus Director's View, mood hotkeys (1 happy, 2 calm, 3 angry, 4 sad, 0 auto), New judge / prompt cards, colorblind palette (config only).

Not verified yet:
- With the user's real headset mic (everything above was tested with synthetic voices through a fake mic).
- The `.jsx` export inside After Effects (it parses as ES3 but has never been run in AE).
- Held-word width live (only tested synthetically).

Known issues:
- **The user's ElevenLabs plan does not support zero-retention mode** (Scribe warning: enterprise/trial only), so audio is logged by ElevenLabs. Don't claim zero retention in the pitch.
- At 1280 px, a line of six shouted words still drops its oldest word even at 65% fit (fits at 1920).
- Untimed commits (if Scribe sends no timestamps) stay unstyled and aren't exported.
- `STREAM_SAFE` and `DEFAULT_PACK` exist in config but aren't implemented.

## Next steps (in priority order)

1. Test with the real mic at venue-like noise levels; tune `THRESHOLDS`, `UNVOICED_SHARE` and `CALIBRATE_WORDS` in `prosody.js` using Director's View readings. Re-run both eval scripts after any change.
2. Run the After Effects export in AE once; fix anything that breaks (ExtendScript is ES3, layer in/out ordering, markers on the Highlights null).
3. Stream-safe mode: replace swear words with a symbol burst (#@%!) at the same size, weight and color.
4. Sync mode: measure caption latency (the learned partial lag plus commit time) and tell the streamer the OBS delay to set.
5. Arcade and Ink style packs (font, palette and outline only; the type grammar never changes) and wire `DEFAULT_PACK`.
6. Shout-line width: consider chunking by measured width instead of word count so shouted lines never drop words.
7. Demo polish: record a real `replay/demo.json` (Stop → Save last session), ideally the Atlanta freestyle clip from the spec, and collect the three customer-discovery quotes (streamer, Deaf/HoH viewer, motion designer).
8. Visual design pass on the control panel and overlay (barebones so far by request).
9. Housekeeping: rename the folder (git init and ignoring `models/` are done).
10. Stretch: two-speaker mode (each speaker on their own side of the screen).
