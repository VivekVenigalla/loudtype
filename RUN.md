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
- Export: `.srt`, `.vtt` (web players/YouTube, with word timing and loudness/emotion styles), a plain transcript `.txt`, and an After Effects `.jsx` (File → Scripts → Run Script File…).
- Look: style pack (Studio, Arcade, Ink for bright video), font, size and position in the control panel. For OBS you can also fix them in the overlay URL, e.g. `http://localhost:7777/overlay/?pack=ink&size=l&position=top`.
- Stream-safe: tick it to show swear words as `#@%!` (same size and color) on stream and in exports.
- Hotkeys on the control panel: 1–7 force a mood (0 = automatic), ← → step through the prompt cards, N = New judge.

Run `npm run setup` once more to fetch the voiceprint model (the main-speaker filter).


Tests: `npm test` (no network; starts its own server on a free port).

## Test on a real Twitch/YouTube stream

Set **Source → Tab audio**, click Start, pick the tab playing the stream in
Chrome's share dialog and tick **Also share tab audio**. You keep hearing it;
Loudtype captions it like a mic. Chrome's "Stop sharing" bar stops the session. Speech-to-text minutes
come from your ElevenLabs quota, so keep test runs short.

## Speakers

By default Loudtype captions **everyone** as one stream: the first few voiced
words calibrate the loudness, then everything heard is captioned.

Tick **Main speaker only** before Start to caption just one person (e.g.
streaming alone in a loud room): the first sentence calibrates them and other
voices near the mic are ignored (on-device voiceprint).
