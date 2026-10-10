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

Not built yet: sync mode, stream-safe censoring (`STREAM_SAFE` does nothing), Arcade/Ink packs.

Tests: `npm test` (no network; starts its own server on a free port).
