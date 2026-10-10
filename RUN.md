# Running Loudtype

```
npm install
npm run setup                 # one-time: emotion model + Roboto Flex into models/ and fonts/
cp config.example.js config.js   # then paste your ElevenLabs API key into config.js
npm start
```

- Control panel: http://localhost:7777/control/ (Chrome, click Start, allow the mic; use a headset mic)
- Overlay: http://localhost:7777/overlay/ (OBS → Sources → Browser, 1920×1080). Add `?bg` to see it over a checkerboard.
- Offline demo: "Play demo clip" replays `replay/demo.json` (no network). Record a real one with Stop → "Save last session", then move the file into `replay/`. `node scripts/make-demo.js` regenerates the scripted clip.
- Export: `.srt` and an After Effects `.jsx` (File → Scripts → Run Script File…).

Only calibrated voices are captioned: the first sentence after Start (or New judge) teaches Loudtype your voiceprint (on-device). Director's View shows each line's match score. Run `npm run setup` once more to fetch the voiceprint model.

Not built yet: sync mode, stream-safe censoring (`STREAM_SAFE` does nothing), Arcade/Ink packs.

Tests: `npm test` (no network; starts its own server on a free port).

## Multiple speakers

Choose **Speakers** (1–32) before Start. With more than one, each person says
the displayed sentence normally while everyone else stays quiet. Keep the mic
and each participant in the position they will use during the conversation.
Wait for **ready**, pause, and click **Calibrate next speaker**. After the last
person, click **Begin conversation**. Calibration phrases are not captioned or
exported. **New judge** recalibrates all speakers (restarts enrollment); Stop → Start creates
a fresh session. All profiles stay in memory.

Use a shared mic and speak in turns. A speaker's pitch may rise when they shout; louder words allow for that. Each matched participant has their own
loudness and held-word reference. Background filtering uses approximate pitch
and volume matching, not voice identification: similar voices, whispers, and
pitch changes can cause false matches or missed words. Simultaneous speech is
not supported. In filtered multi-speaker mode captions wait for word timestamps;
untimed lines are dropped. Speaker colors/brackets and new emotion animations
are not included in this stage.
