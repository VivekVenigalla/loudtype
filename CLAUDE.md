# Loudtype

**Live captions that sound like you.** A live caption overlay for streamers: loud words are big and heavy, whispers small and light, held words stretch wide, and each line is tinted with its emotion. Words never move off one shared baseline.

Built for **Hacklanta '26, Creative track (Adobe)**, also entered for MLH Best Use of ElevenLabs and the Zero Data Challenge. The original product spec was pasted in chat (not in the repo); its essentials are summarized below. `DEMO.md` holds the judging-table script and Q&A; `RUN.md` the quick-start.

## Run

```bash
npm install
npm run setup                    # one-time: GoEmotions + voiceprint (WeSpeaker) models + Roboto Flex into models/ and fonts/
cp config.example.js config.js   # add ELEVENLABS_API_KEY (config.js is gitignored and already exists locally)
npm start                        # http://localhost:7777/control/ and /overlay/
npm test                         # node:test, no network; starts its own server on a free port
npm run typecheck                # tsc over the DOM-free modules (JSDoc types, nothing compiled)
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

- **server.js** (Node, only runtime dep `ws`): serves `control/ overlay/ fonts/ models/ replay/` (whitelisted top-level dirs only, checked in `server-paths.js` *after* resolving `..`, so `config.js` and `server.js` are never served), streamed, maps `/vendor/transformers/` → `@huggingface/transformers/dist` and `/vendor/ort/` → `onnxruntime-web/dist`. `GET /token` mints a single-use Scribe token (API key never reaches the browser). `GET /config` returns config minus the key. `/relay` rebroadcasts control → overlay; stores nothing.
  - Security rules (each has a test in `test/server.test.js`): only loopback `Host` headers are answered (DNS rebinding); the relay only accepts an `Origin` from this server; a malformed request gets 400/404, never a crash. Every response carries COOP/COEP (cross-origin isolation → the emotion model runs on 4 threads, ~2× faster per line); so pages must not load anything from another origin.
  - `LOUDTYPE_PORT=7791 node server.js` runs a second copy for testing next to the user's server on 7777.
- **control/**
  - `app.js`: UI wiring: session start/stop, Scribe reconnect (up to 3 tries, calibration kept; auth/quota errors stop), replay, export, Director's View, mood hotkeys, judge prompt cards. `latest` = the newest session (running or stopped); only it may send, log or export. Director's View shows the mic and whether Chrome honored auto gain/noise suppression off, the room noise floor, and **Copy mic report** (JSON of the last 40 words' dB, vs-normal, voicing, level; also `window.loudtype.micReport()`): ask the user for it when tuning a real mic. `window.loudtype.session()` exposes the live session for debugging.
  - `transcript.js`: the partial → commit → timestamped-commit state machine (no DOM; dependencies injected). Waits 600 ms for the timestamped commit; a late one upgrades the line in place. Keeps the session's exportable `lines`; word times stay on the session clock across reconnects (`origin`).
  - `caption.js`: the shared grammar (levels, level order, icons, emotion colors, model id) and the JSDoc types of the caption event. `overlay/style.css` repeats the colors; `test/caption.test.js` keeps them in sync.
  - `audio.js` + `pcm-worklet.js`: mic with AGC/noise suppression **off** (they'd flatten loudness). All measurement happens **in the worklet** with exact `currentTime` stamps; main-thread timing was ~0.5 s off while the model loaded.
  - `features.js`: per-frame `{db, voicing}`; voicing = normalized autocorrelation peak at 70–400 Hz (whispers ≈ unvoiced). Shared by worklet and eval scripts.
  - `prosody.js`: learns the speaker's normal level (median of the first 6 *voiced* words), then levels by fixed dB offsets: whisper ≤ −10 or (voiced share < 0.3 and < +4 dB), soft ≤ −6, loud ≥ +6 (were ±5: normal speech wobbles to +5.1 and jumped size), shout ≥ +8; all divided by `sensitivity` (control-panel slider 0.5–1.5, `Prosody.thresholds()`) (was +10: on AirPods real shouts measured +8.2…+9.7 because the earbuds compress loud input; the laptop mic gave +14…+15; normal speech peaked at +5.1). "Normal" slowly tracks the speaker (only from normal words). Noise floor = 10th percentile of the last 15 s (5 s of nonstop talking pulled it up into the voice), clamped ≥ −72 dB. A committed word whose timing lands on a pause (no speech frames, within 3 dB of the floor) stays normal and teaches nothing. Width (`wdth` 100–151) from ms-per-letter vs. the speaker's median. `styleLive()` styles partial words instantly; committed timestamps then correct them.
  - `stt.js`: Scribe realtime (`commit_strategy=vad`, `include_timestamps=true`, `vad_silence_threshold_secs` from config). Warnings surface in the status line.
  - `emotion.js` / `emotion-core.js`: GoEmotions (`SamLowe/roberta-base-go_emotions-onnx`, q8, local only) → pos/neg/neutral, a stream-slang regex layer, and energy = mostly voice levels + some text arousal. Quadrant: pos+high → happy ★ yellow, pos+low → calm ● green, neg+high → angry ▲ red, neg+low → sad ▼ blue; neutral/low confidence → white.
  - `relay.js` (ws client + in-memory `Recording` for replay, last 10 minutes only), `export.js` (`.srt` + ExtendScript `.jsx`; **ES3 only** and **pure ASCII** in generated code).
- **overlay/** `render.js`: chunks long utterances (7 words or a sentence end), max 2 lines, staggered 90 ms fade-in per word, shrink-to-fit (`--fit` ≥ 0.65) before hiding oldest words, clears after 3.5 s silence. Fit uses `offsetWidth` against the stage width (transforms from the shout pop must not count). `style.css`: Studio pack, per-level outlines (thin for whispers, heavy for shouts), word spacing in `em` of each word, colorblind palette via the `.colorblind` class.

**Caption event** sent to the overlay (typed as `CaptionEvent` in `caption.js`): `{type:'line', line, final, provisional, emotion, confidence, words:[{word, level, size, wght, wdth, start?, end?}]}`. Other types: `calib {progress}`, `pack {pack}`, `prompt {text, step, of}`, `clear`.

**Main speaker only** (`IGNORE_BACKGROUND`, checkbox "Ignore background"): calibration also learns the main speaker's pitch (`features.js` now returns `pitch`). Two layers: `gate.js` in the worklet silences audio under max(normal − 18 dB, noise + 6) before Scribe (150 ms lookahead, 350 ms hangover; chunk times shifted by the delay), and `prosody.background()` drops clearly voiced (≥ 50%) words that are > 12 dB under normal, or 3–12 dB under at a pitch outside −5…+7 semitones; whispers (unvoiced) are always kept; a line mostly someone else's is dropped whole. Loud unvoiced bursts (claps, bumps) never read loud. Tests: `test/ballroom*.test.js` (synthetic + real `say` voices via `scripts/scenes.mjs`), `node scripts/eval-ballroom.mjs` (Scribe, ~1 min quota): main speaker 35/35 kept, nearby talker 1/14 captioned (was 14/14). Known limits: in loud chatter the gate stays open (word filter does the work); a same-pitch person leaning in (within 3–12 dB) is captioned; chatter words timed onto a pause (silent path) are kept.

**Voiceprints: only calibrated voices are captioned** (`voiceprint-core.js` logic, `voiceprint.js` model loader, `ml.js` shared transformers.js setup). On a MacBook mic, someone 2–3 m away is only ~2–9 dB quieter than the speaker, so level and pitch alone can't separate them. Model: `onnx-community/wespeaker-voxceleb-resnet34-LM` (CC-BY-4.0, fp32 26 MB, on-device, ~20–30 ms per line). Enrollment = the calibration words (loudest-voice cluster) plus up to 3 s more of the speaker's words until the voiceprint exists (`Prosody.enrollSpans`; 6 words alone, ~1 s, enrolled too weakly and dropped the speaker's next line in the browser test). The worklet sends pre-gate 16 kHz audio with each chunk into an `AudioRing` (last 60 s, memory only). Each committed line is embedded before styling (`transcript.identify` → `prosody.voice`): "Voice filter" select: **relaxed** (default) cosine ≥ 0.5 match, < 0.25 other (lines < 1 s: 0.45 / 0.15); **strict** 0.6 / 0.45 (0.55 / 0.3); else unsure → level/pitch rules. Strict rejected the user's own lines on the MacBook mic, hence relaxed. Lines judged 'match' (≥ 1 s) refine the voiceprint (centroid of enrollment + last 8). Margin note: eval strangers scored ≤ 0.20, under relaxed's 0.25. 'other' drops the whole line incl. whispered words; whispered lines (< 35% voiced) are never judged. Partials: shown at once (waiting for the first check made the speaker's words late) and hidden while a check says 'other'; partial words that level/pitch call background wait for the commit. Multi-speaker: one voiceprint per profile; a sure match (best beats next by 0.08) assigns the line to that profile, else per-word pitch/level matching. Director's View shows "Voiceprint: n/n enrolled · last line: you ✓ (0.68)". Gate: never above normal − 8 dB (the speaker's own words always pass); before calibration/while enrolling noise + 5 (was + 10: on a laptop mic the voice is only ~12 dB over the room, so calibration speech was cut). Unvoiced frames (whispers) open it from max(noise + 3, normal − 22) for 150 ms (on the Mac mic whispers sit ~8 dB under normal, only ~6 dB over the room, and were cut before). Scribe's `filter_background_audio` can't be combined with `include_timestamps` (Scribe rejects it), and `vad_threshold` 0.6 didn't help (eval-ballroom --mac), so neither is used. Results: `node scripts/eval-voiceprint.mjs [--mac]` (offline, real model): 8/8 lines right on both mics; browser fake-mic test with the Mac scene via Scribe: all 6 main-speaker lines kept (whisper and shout styled), all 3 stranger lines dropped, no stranger partial ever shown. Limits: lines under ~1 s are often 'unsure'; a stranger whispering into the mic is kept; a voice similar to the speaker's (same-engine TTS scored up to 0.59) can pass; real humans and real rooms not yet measured, so the thresholds may need tuning from Director's View readings.

**Speakers: label everyone (default, no calibration)** (`speakers.js` `Speakers({ auto: true })`; "Main speaker only" checkbox / `IGNORE_BACKGROUND: true` = the old calibrated single-speaker filter). Replaced the guided 1–32 speaker enrollment, which kept failing. `Voiceprints.diarize()`: each committed line ≥ 0.4 s voiced is embedded; it joins the closest speaker centroid if cosine ≥ `DIARIZE.JOIN` 0.4, else (≥ 1 s) starts a new speaker (max 8); shorter, whispered or silent lines stay with the last speaker; speakers whose centroids converge to ≥ 0.55 merge (alias). Partials only guess (never add a speaker) and otherwise show the last speaker (S1 before anyone). Each speaker has their own `Prosody` profile (`Speakers.profile(i)`, created on first use) whose first 6 voiced words learn their normal (shown normal until then). Gate off (everyone captioned). Line events carry `speaker` (1-based); overlay draws a neutral "S1" chip (never colored: color = emotion); .srt prefixes "S1: " when > 1 speaker; the AE export doesn't label speakers yet. Results: `node scripts/eval-voiceprint.mjs --everyone [--mac]`: close mic 7/7 voiced lines consistent (3 labels for 3 voices); Mac scene 6/7 (Daniel far+echo vs. near scored 0.39 → a 4th label; lowering JOIN would merge Tessa into Samantha, 0.35). Browser + Scribe (Mac scene): the main speaker stayed S1 for all 5 of their lines incl. shout; Scribe merged the whisper with the next stranger line (labeled S2) and never committed the far stranger's line. Limits: whispers/short lines take the last speaker's label; overlapping speech; similar voices.

## Design rules (from the spec; don't break them)

- One baseline. No vertical movement, rotation, shaking or size transitions. The only motion is the ~80 ms fade-in and the optional 108% shout pop.
- Each visual property means one thing: size+weight = loudness, width = held length, color+icon = emotion. Color is never the only signal (icons).
- Only tint when confident; a white line beats a wrong color.
- Zero data: no accounts or analytics, nothing written to disk except on Export/Save click, emotion runs on-device, only outside host is ElevenLabs.
- Levels: whisper 0.75×/wght 220, soft 0.9×/350, normal 1×/450, loud 1.25×/700, shout 1.6×/1000.

## Testing

- `npm test` (158 tests, ~4 s, no network, no model; voiceprints use a fake embedding): server security and file serving against a real copy on a free port, path resolution, transcript state machine (fake Scribe events, mocked timers), prosody (synthetic frames), emotion-core (fixed scores), features, export, relay recording, caption sync. Run it after every change. `npm run typecheck` too.
- `node scripts/eval-volume.mjs [old-prosody.js]` (ask first: uses the user's ElevenLabs quota): builds a clip with macOS `say` (incl. the `Whisper` voice) where every word's level is known, gets real Scribe timestamps (needs the key, uses network), scores levels. Last result (2026-10-10, shout threshold +8): 46/51 exact, 51/51 within one level. Misses: 4 whispers read as soft (same as before), and "so" in the +7 dB "loud" sentence now reads as shout (the clip's loud segment sits 1 dB under the new line; accepted to catch real AirPods shouts). With +10: 47/51, and 48/51 before the silent-word fix (Scribe tokenizes differently each run and the clip's noise is random, so ±1 is normal). Old z-score method: 44/51.
- `node scripts/eval-ballroom.mjs [--mac] [--only-gated] [--scribe key=value]` (uses quota): `--mac` is the room as a MacBook mic hears it (`MAC_LEVEL` in scenes.mjs, echo on everyone else).
- `node scripts/eval-voiceprint.mjs [--mac] [--everyone]`: offline, no quota, real voiceprint model on the real-voices ballroom (`--everyone`: speaker labels, no calibration).
- `node scripts/eval-emotion.mjs`: 30 tuning lines, 20 held-out lines, 8 voice-quadrant cases. Last result: tuning 30/30, held-out 18/20 (old SST-2: 12/20), quadrants 8/8. Don't tune on the held-out set.
- **Fake-mic browser test:** put a WAV in `replay/`, then in the control tab override `navigator.mediaDevices.getUserMedia` to return `MediaStreamDestination.stream` from an `AudioBufferSource`, click Start, and watch the overlay DOM (MutationObserver) in another tab. This is how the end-to-end pipeline was verified (last: after the audit, incl. a forced Scribe drop to test reconnect). The fake `AudioContext` needs a real click on Start (user gesture). Delete test WAVs afterwards.
- `node scripts/make-demo.js` regenerates the scripted offline clip `replay/demo.json`.
- Measured facts: Scribe partials arrive in bursts ~1/s, ~0.8 s after speech (learned at runtime from timestamps).

## Status

Done: priorities 1–8 of the spec (overlay, loudness → size/weight, Studio pack, emotion + icons + confidence gating, OBS transparent page, offline replay, width for held words, `.srt` + After Effects export with highlight markers), plus Director's View, mood hotkeys (1 happy, 2 calm, 3 angry, 4 sad, 0 auto), New judge / prompt cards, colorblind palette (config only).

Not verified yet:
- Real mics (2026-10-10, via Copy mic report): **AirPods** work: 36 dB above room noise, whispers 7/7, shouts +8…+10 (hence the +8 threshold); Chrome honors AGC/NS off. **MacBook Air mic**: only 12 dB above room noise; whispers caught by voicing alone, so a noisy venue will bury them. Use a headset. Not yet tried at venue noise levels.
- "Test, test" is a poor calibration phrase (mostly unvoiced consonants, 17–57% voiced); prompt card 1 is a good one.
- The `.jsx` export inside After Effects (it parses as ES3 but has never been run in AE).
- Held-word width live (only tested synthetically).

Known issues:
- **The user's ElevenLabs plan does not support zero-retention mode** (Scribe warning: enterprise/trial only), so audio is logged by ElevenLabs. Don't claim zero retention in the pitch.
- At 1280 px, a line of six shouted words still drops its oldest word even at 65% fit (fits at 1920).
- Untimed commits (if Scribe never sends timestamps for a line) stay unstyled and aren't exported.
- After an OBS-side change of the overlay URL host (e.g. a custom hostname), the relay refuses it: use `localhost` or `127.0.0.1`.
- `STREAM_SAFE` exists in config but isn't implemented (defaults to `false`, commented as such).

## Next steps (in priority order)

1. Test voiceprints with two real people on the MacBook mic (Director's View shows each line's score); tune `VOICE` in `voiceprint-core.js` if the speaker's own lines score under 0.6.
1b. Test with the real mic at venue-like noise levels; tune `THRESHOLDS`, `UNVOICED_SHARE` and `CALIBRATE_WORDS` in `prosody.js` using Director's View readings. Re-run both eval scripts after any change.
2. Run the After Effects export in AE once; fix anything that breaks (ExtendScript is ES3, layer in/out ordering, markers on the Highlights null).
3. Stream-safe mode: replace swear words with a symbol burst (#@%!) at the same size, weight and color.
4. Sync mode: measure caption latency (the learned partial lag plus commit time) and tell the streamer the OBS delay to set.
5. Arcade and Ink style packs (font, palette and outline only; the type grammar never changes) and add a `DEFAULT_PACK` config option.
6. Shout-line width: consider chunking by measured width instead of word count so shouted lines never drop words.
7. Demo polish: record a real `replay/demo.json` (Stop → Save last session), ideally the Atlanta freestyle clip from the spec, and collect the three customer-discovery quotes (streamer, Deaf/HoH viewer, motion designer).
8. Visual design pass on the control panel and overlay (barebones so far by request).
9. Housekeeping: rename the folder (git init and ignoring `models/` are done).
10. Speaker labels: test with 2–3 real people; put the speaker in the AE export; consider per-speaker sides of the screen.
