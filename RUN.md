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

Run `npm run setup` once more to fetch the voiceprint model (speaker labels and the main-speaker filter).

Not built yet: sync mode, stream-safe censoring (`STREAM_SAFE` does nothing), Arcade/Ink packs.

Tests: `npm test` (no network; starts its own server on a free port).

## Speakers

By default Loudtype **labels everyone**: no calibration, just click Start and talk.
Each line gets a small **S1**, **S2**… chip from an on-device voiceprint of that
line (about a second of speech is enough). Each person's loudness is measured
against their own normal, learned from their first few words (shown at normal
size until then). New judge forgets every voice.

Tick **Main speaker only** before Start to caption just one person (e.g.
streaming alone in a loud room): the first sentence calibrates them and
everyone else is ignored.

Limits: short lines ("yes", "what?") and whispers stay with the last speaker;
similar voices may share a label, and one person who sounds very different
(across the room vs. leaning in) can get a second label; overlapping speech is
not supported. The .srt export prefixes lines with "S1: " when several speakers
were heard.
